import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { capitalEntries, wallets, walletTransactions } from '@/db/schema';
import { estimateStripeProcessingFeeCents } from '@/lib/checkout-fees';

export const STRIPE_DISPUTE_FEE_CENTS = 1500;

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface SettlementCredit {
  id: string;
  walletId: string;
  amountCents: number;
  type: string;
}

interface LossAllocation {
  credit: SettlementCredit;
  principalCents: number;
  feeCents: number;
}

function allocateExact(totalCents: number, weights: number[]): number[] {
  if (totalCents <= 0 || weights.length === 0) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (weightTotal <= 0) return weights.map(() => 0);

  const raw = weights.map((weight) => (totalCents * Math.max(0, weight)) / weightTotal);
  const allocated = raw.map(Math.floor);
  const remainder = totalCents - allocated.reduce((sum, amount) => sum + amount, 0);
  const order = raw
    .map((amount, index) => ({ index, fraction: amount - Math.floor(amount) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; i < remainder; i += 1) {
    allocated[order[i % order.length].index] += 1;
  }
  return allocated;
}

async function loadSettlementCredits(
  tx: DbTx,
  paymentIntentId: string,
): Promise<SettlementCredit[]> {
  const rows = await tx
    .select({
      id: walletTransactions.id,
      walletId: walletTransactions.toWalletId,
      amountCents: walletTransactions.amountCents,
      type: walletTransactions.type,
    })
    .from(walletTransactions)
    .where(
      and(
        inArray(walletTransactions.type, ['marketplace_payout', 'service_fee', 'group_deposit']),
        sql`${walletTransactions.metadata}->>'paymentIntentId' = ${paymentIntentId}`,
        sql`${walletTransactions.toWalletId} IS NOT NULL`,
        sql`${walletTransactions.amountCents} > 0`,
      ),
    );

  return rows
    .filter((row): row is typeof row & { walletId: string } => Boolean(row.walletId))
    .map((row) => ({
      id: row.id,
      walletId: row.walletId,
      amountCents: row.amountCents,
      type: row.type,
    }));
}

async function priorPrincipalByCredit(
  tx: DbTx,
  paymentIntentId: string,
  source: 'refund_clawback' | 'chargeback',
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ metadata: walletTransactions.metadata })
    .from(walletTransactions)
    .where(
      and(
        sql`${walletTransactions.metadata}->>'source' = ${source}`,
        sql`${walletTransactions.metadata}->>'paymentIntentId' = ${paymentIntentId}`,
      ),
    );

  const result = new Map<string, number>();
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const creditId = metadata.originalSettlementTransactionId;
    const principal = Number(metadata.principalCents ?? 0);
    if (typeof creditId === 'string' && Number.isInteger(principal) && principal > 0) {
      result.set(creditId, (result.get(creditId) ?? 0) + principal);
    }
  }
  return result;
}

/**
 * Total fee already recovered for this payment intent under `source`. Fees are
 * netted against prior recoveries exactly like principal — a redelivered or
 * cumulative event must never re-charge the processing/dispute fee.
 */
async function priorFeeCents(
  tx: DbTx,
  paymentIntentId: string,
  source: 'refund_clawback' | 'chargeback',
): Promise<number> {
  const rows = await tx
    .select({ feeCents: walletTransactions.feeCents })
    .from(walletTransactions)
    .where(
      and(
        sql`${walletTransactions.metadata}->>'source' = ${source}`,
        sql`${walletTransactions.metadata}->>'paymentIntentId' = ${paymentIntentId}`,
      ),
    );
  return rows.reduce((sum, row) => sum + (row.feeCents ?? 0), 0);
}

async function reduceSourceCapital(
  tx: DbTx,
  creditId: string,
  principalCents: number,
): Promise<number> {
  const [entry] = await tx
    .select({
      id: capitalEntries.id,
      remainingCents: capitalEntries.remainingCents,
    })
    .from(capitalEntries)
    .where(eq(capitalEntries.sourceTransactionId, creditId))
    .limit(1)
    .for('update');
  if (!entry || entry.remainingCents <= 0) return 0;

  const reduction = Math.min(entry.remainingCents, principalCents);
  await tx
    .update(capitalEntries)
    .set({
      remainingCents: sql`${capitalEntries.remainingCents} - ${reduction}`,
      updatedAt: new Date(),
    })
    .where(eq(capitalEntries.id, entry.id));
  return reduction;
}

async function applyLossAllocations(
  tx: DbTx,
  allocations: LossAllocation[],
  metadata: Record<string, unknown>,
  source: 'refund_clawback' | 'chargeback',
): Promise<number> {
  const walletIds = Array.from(new Set(allocations.map((item) => item.credit.walletId))).sort();
  for (const walletId of walletIds) {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
  }

  let debitedCents = 0;
  for (const allocation of allocations) {
    const amountCents = allocation.principalCents + allocation.feeCents;
    if (amountCents <= 0) continue;
    const capitalReducedCents = await reduceSourceCapital(
      tx,
      allocation.credit.id,
      allocation.principalCents,
    );

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, allocation.credit.walletId));

    await tx.insert(walletTransactions).values({
      type: 'refund',
      fromWalletId: allocation.credit.walletId,
      amountCents,
      feeCents: allocation.feeCents,
      currency: 'usd',
      description:
        source === 'chargeback'
          ? 'Chargeback recovery'
          : 'Refund recovery',
      status: 'completed',
      metadata: {
        ...metadata,
        source,
        originalSettlementTransactionId: allocation.credit.id,
        principalCents: allocation.principalCents,
        feeCents: allocation.feeCents,
        capitalReducedCents,
      },
    });
    debitedCents += amountCents;
  }
  return debitedCents;
}

function buildAllocations(
  credits: SettlementCredit[],
  targetPrincipalCents: number,
  targetFeeCents: number,
  prior: Map<string, number>,
): LossAllocation[] {
  const principalTargets = allocateExact(
    Math.min(targetPrincipalCents, credits.reduce((sum, credit) => sum + credit.amountCents, 0)),
    credits.map((credit) => credit.amountCents),
  );
  const principalDeltas = principalTargets.map((target, index) =>
    Math.max(0, target - (prior.get(credits[index].id) ?? 0)),
  );
  const payoutWeights = credits.map((credit, index) =>
    credit.type === 'marketplace_payout' && principalDeltas[index] > 0
      ? credit.amountCents
      : 0,
  );
  // A fee-only delta (principal fully recovered earlier, fee not) still needs
  // somewhere to land: fall back to the payout credits by size.
  const feeWeights = payoutWeights.some((weight) => weight > 0)
    ? payoutWeights
    : credits.map((credit) => (credit.type === 'marketplace_payout' ? credit.amountCents : 0));
  const feeAllocations = allocateExact(targetFeeCents, feeWeights);

  return credits
    .map((credit, index) => ({
      credit,
      principalCents: principalDeltas[index],
      feeCents: feeAllocations[index],
    }))
    .filter((allocation) => allocation.principalCents > 0 || allocation.feeCents > 0);
}

export async function clawbackRefund(params: {
  eventId: string;
  paymentIntentId: string;
  chargeAmountCents: number;
  totalRefundedCents: number;
}): Promise<{ recovered: boolean; debitedCents?: number; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.paymentIntentId}, 0))`,
    );
    const credits = await loadSettlementCredits(tx, params.paymentIntentId);
    if (credits.length === 0) return { recovered: false, reason: 'no-internal-credit' };
    const creditedTotal = credits.reduce((sum, credit) => sum + credit.amountCents, 0);
    const targetPrincipal = Math.round(
      (creditedTotal * Math.min(params.totalRefundedCents, params.chargeAmountCents)) /
        Math.max(1, params.chargeAmountCents),
    );
    const prior = await priorPrincipalByCredit(tx, params.paymentIntentId, 'refund_clawback');
    const alreadyRecovered = Array.from(prior.values()).reduce((sum, amount) => sum + amount, 0);
    const deltaPrincipal = Math.max(0, targetPrincipal - alreadyRecovered);

    // Stripe keeps its processing fee on a refund, so the fee is recovered on
    // top of principal — estimated on the refunded CHARGE amount (which the
    // buyer actually paid, tax included), not on the internal credited
    // principal, and netted against fees already recovered.
    const targetFeeCents = estimateStripeProcessingFeeCents(
      Math.min(params.totalRefundedCents, params.chargeAmountCents),
    );
    const deltaFeeCents = Math.max(
      0,
      targetFeeCents - (await priorFeeCents(tx, params.paymentIntentId, 'refund_clawback')),
    );
    if (deltaPrincipal <= 0 && deltaFeeCents <= 0) {
      return { recovered: false, reason: 'already-processed' };
    }

    const allocations = buildAllocations(credits, targetPrincipal, deltaFeeCents, prior);
    const debitedCents = await applyLossAllocations(
      tx,
      allocations,
      {
        stripeEventId: params.eventId,
        paymentIntentId: params.paymentIntentId,
        chargeAmountCents: params.chargeAmountCents,
        totalRefundedCents: params.totalRefundedCents,
      },
      'refund_clawback',
    );
    return { recovered: debitedCents > 0, debitedCents };
  });
}

export async function clawbackChargeback(params: {
  eventId: string;
  paymentIntentId: string;
  disputeId: string;
  chargeAmountCents: number;
  disputeAmountCents: number;
  disputeFeeCents?: number;
}): Promise<{ recovered: boolean; debitedCents?: number; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.paymentIntentId}, 0))`,
    );
    const credits = await loadSettlementCredits(tx, params.paymentIntentId);
    if (credits.length === 0) return { recovered: false, reason: 'no-internal-credit' };
    const creditedTotal = credits.reduce((sum, credit) => sum + credit.amountCents, 0);
    const targetPrincipal = Math.round(
      (creditedTotal * Math.min(params.disputeAmountCents, params.chargeAmountCents)) /
        Math.max(1, params.chargeAmountCents),
    );
    const prior = await priorPrincipalByCredit(tx, params.paymentIntentId, 'chargeback');
    const alreadyRecovered = Array.from(prior.values()).reduce((sum, amount) => sum + amount, 0);
    const deltaPrincipal = Math.max(0, targetPrincipal - alreadyRecovered);
    // Net the dispute fee against prior recoveries so a redelivered dispute
    // event cannot charge the seller the fee a second time.
    const deltaFeeCents = Math.max(
      0,
      (params.disputeFeeCents ?? STRIPE_DISPUTE_FEE_CENTS) -
        (await priorFeeCents(tx, params.paymentIntentId, 'chargeback')),
    );
    if (deltaPrincipal <= 0 && deltaFeeCents <= 0) {
      return { recovered: false, reason: 'already-processed' };
    }
    const allocations = buildAllocations(credits, targetPrincipal, deltaFeeCents, prior);
    const debitedCents = await applyLossAllocations(
      tx,
      allocations,
      {
        stripeEventId: params.eventId,
        disputeId: params.disputeId,
        paymentIntentId: params.paymentIntentId,
        chargeAmountCents: params.chargeAmountCents,
        disputeAmountCents: params.disputeAmountCents,
      },
      'chargeback',
    );
    return { recovered: debitedCents > 0, debitedCents };
  });
}

export async function reverseChargebackClawback(params: {
  eventId: string;
  paymentIntentId: string;
  disputeId: string;
}): Promise<{ reversed: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.paymentIntentId}, 0))`,
    );
    const clawbacks = await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          sql`${walletTransactions.metadata}->>'source' = 'chargeback'`,
          sql`${walletTransactions.metadata}->>'disputeId' = ${params.disputeId}`,
          sql`${walletTransactions.metadata}->>'reversedAt' IS NULL`,
        ),
      )
      .for('update');
    if (clawbacks.length === 0) {
      // Distinguish "this reversal already ran" from "no such clawback": a
      // redelivered reinstatement finds only already-reversed rows.
      const reversedRows = await tx
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(
          and(
            sql`${walletTransactions.metadata}->>'source' = 'chargeback'`,
            sql`${walletTransactions.metadata}->>'disputeId' = ${params.disputeId}`,
            sql`${walletTransactions.metadata}->>'reversedAt' IS NOT NULL`,
          ),
        )
        .limit(1);
      return {
        reversed: false,
        reason: reversedRows.length > 0 ? 'already-processed' : 'clawback-not-found',
      };
    }

    const walletIds = Array.from(
      new Set(
        clawbacks
          .map((row) => row.fromWalletId)
          .filter((walletId): walletId is string => Boolean(walletId)),
      ),
    ).sort();
    for (const walletId of walletIds) {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
    }

    const reversedAt = new Date().toISOString();
    for (const clawback of clawbacks) {
      if (!clawback.fromWalletId) continue;
      const metadata = (clawback.metadata ?? {}) as Record<string, unknown>;
      const capitalReducedCents = Number(metadata.capitalReducedCents ?? 0);
      const originalCreditId = metadata.originalSettlementTransactionId;

      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${clawback.amountCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, clawback.fromWalletId));

      if (
        typeof originalCreditId === 'string' &&
        Number.isInteger(capitalReducedCents) &&
        capitalReducedCents > 0
      ) {
        await tx
          .update(capitalEntries)
          .set({
            remainingCents: sql`LEAST(${capitalEntries.amountCents}, ${capitalEntries.remainingCents} + ${capitalReducedCents})`,
            updatedAt: new Date(),
          })
          .where(eq(capitalEntries.sourceTransactionId, originalCreditId));
      }

      await tx
        .update(walletTransactions)
        .set({ metadata: { ...metadata, reversedAt, reversalEventId: params.eventId } })
        .where(eq(walletTransactions.id, clawback.id));
      await tx.insert(walletTransactions).values({
        type: 'refund',
        toWalletId: clawback.fromWalletId,
        amountCents: clawback.amountCents,
        feeCents: 0,
        currency: clawback.currency,
        description: 'Chargeback reversed after dispute funds were reinstated',
        status: 'completed',
        metadata: {
          source: 'chargeback_reversal',
          stripeEventId: params.eventId,
          disputeId: params.disputeId,
          paymentIntentId: params.paymentIntentId,
          originalClawbackTransactionId: clawback.id,
        },
      });
    }
    return { reversed: true };
  });
}
