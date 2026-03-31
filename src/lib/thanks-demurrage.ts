import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { ledger, resources, wallets, type NewLedgerEntry } from "@/db/schema";
import {
  calculateThanksTokenAgeWeeks,
  calculateThanksTokenWeeklyContribution,
  getThanksDemurrageCycleKey,
  summarizeThanksTokenDemurrage,
  toTokenEntryDate,
  type ThanksTokenDemurrageSnapshot,
  type ThanksTokenDemurrageSummary,
} from "@/lib/thanks-demurrage-core";
import { getSettlementWalletForAgent } from "@/lib/wallet";

export {
  calculateThanksTokenAgeWeeks,
  calculateThanksTokenWeeklyContribution,
  getThanksDemurrageCycleKey,
  summarizeThanksTokenDemurrage,
  type ThanksTokenDemurrageSnapshot,
  type ThanksTokenDemurrageSummary,
};

async function fetchActiveThanksTokensForOwner(ownerId: string): Promise<ThanksTokenDemurrageSnapshot[]> {
  return db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      enteredAccountAt: resources.enteredAccountAt,
      createdAt: resources.createdAt,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        eq(resources.type, "thanks_token"),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(asc(resources.enteredAccountAt), asc(resources.createdAt), asc(resources.id));
}

export async function previewThanksTokenDemurrageForOwner(
  ownerId: string,
  now: Date = new Date(),
): Promise<ThanksTokenDemurrageSummary> {
  const settlementWallet = await getSettlementWalletForAgent(ownerId);
  const [wallet] = await db
    .select({ hiddenBurnRemainder: wallets.hiddenBurnRemainder })
    .from(wallets)
    .where(eq(wallets.id, settlementWallet.id))
    .limit(1);

  const tokens = await fetchActiveThanksTokensForOwner(ownerId);
  return summarizeThanksTokenDemurrage(
    ownerId,
    tokens,
    wallet?.hiddenBurnRemainder ?? 0,
    now,
  );
}

export async function processThanksTokenDemurrageForOwner(
  ownerId: string,
  now: Date = new Date(),
): Promise<ThanksTokenDemurrageSummary> {
  const settlementWallet = await getSettlementWalletForAgent(ownerId);
  const burnedAtIso = now.toISOString();
  const cycleKey = getThanksDemurrageCycleKey(now);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${settlementWallet.id} FOR UPDATE`);

    const [wallet] = await tx
      .select({
        id: wallets.id,
        hiddenBurnRemainder: wallets.hiddenBurnRemainder,
      })
      .from(wallets)
      .where(eq(wallets.id, settlementWallet.id))
      .limit(1);

    if (!wallet) {
      throw new Error(`Wallet not found for owner ${ownerId}`);
    }

    const [existingCycle] = await tx
      .select({ id: ledger.id })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, ownerId),
          eq(ledger.verb, "consume"),
          eq(ledger.isActive, true),
          sql`${ledger.metadata}->>'interactionType' = 'thanks-token-demurrage-cycle'`,
          sql`${ledger.metadata}->>'cycleKey' = ${cycleKey}`,
        ),
      )
      .limit(1);

    const tokens = await tx
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        enteredAccountAt: resources.enteredAccountAt,
        createdAt: resources.createdAt,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, ownerId),
          eq(resources.type, "thanks_token"),
          isNull(resources.deletedAt),
        ),
      )
      .orderBy(asc(resources.enteredAccountAt), asc(resources.createdAt), asc(resources.id));

    const summary = summarizeThanksTokenDemurrage(
      ownerId,
      tokens,
      wallet.hiddenBurnRemainder ?? 0,
      now,
    );

    if (existingCycle) {
      return summary;
    }

    if (summary.totalContribution <= 0 && summary.burnCount <= 0) {
      await tx.insert(ledger).values({
        subjectId: ownerId,
        verb: "consume",
        objectId: ownerId,
        objectType: "agent",
        metadata: {
          interactionType: "thanks-token-demurrage-cycle",
          cycleKey,
          burnCount: 0,
          tokenCount: summary.tokenCount,
          eligibleTokenCount: summary.eligibleTokenCount,
          totalContribution: summary.totalContribution,
          remainderBefore: summary.remainderBefore,
          remainderAfter: summary.remainderAfter,
        },
      } as NewLedgerEntry);
      return summary;
    }

    await tx
      .update(wallets)
      .set({
        hiddenBurnRemainder: summary.remainderAfter,
      })
      .where(eq(wallets.id, wallet.id));

    for (const token of tokens.slice(0, summary.burnCount)) {
      const ageWeeks = calculateThanksTokenAgeWeeks(toTokenEntryDate(token), now);
      const contribution = calculateThanksTokenWeeklyContribution(ageWeeks);
      const metadata = (token.metadata ?? {}) as Record<string, unknown>;

      await tx
        .update(resources)
        .set({
          deletedAt: now,
          metadata: {
            ...metadata,
            burnedAt: burnedAtIso,
            burnReason: "demurrage",
            burnAgeWeeks: ageWeeks,
            lastWeeklyBurnContribution: contribution,
          },
        })
        .where(eq(resources.id, token.id));

      await tx.insert(ledger).values({
        subjectId: ownerId,
        verb: "consume",
        objectId: token.id,
        objectType: "resource",
        resourceId: token.id,
        metadata: {
          interactionType: "thanks-token-demurrage-burn",
          burnReason: "demurrage",
          enteredAccountAt: toTokenEntryDate(token).toISOString(),
          burnAgeWeeks: ageWeeks,
          weeklyContribution: contribution,
          remainderAfter: summary.remainderAfter,
          cycleKey,
        },
      } as NewLedgerEntry);
    }

    await tx.insert(ledger).values({
      subjectId: ownerId,
      verb: "consume",
      objectId: ownerId,
      objectType: "agent",
      metadata: {
        interactionType: "thanks-token-demurrage-cycle",
        cycleKey,
        burnCount: summary.burnCount,
        tokenCount: summary.tokenCount,
        eligibleTokenCount: summary.eligibleTokenCount,
        totalContribution: summary.totalContribution,
        remainderBefore: summary.remainderBefore,
        remainderAfter: summary.remainderAfter,
        burnedTokenIds: summary.burnedTokenIds,
      },
    } as NewLedgerEntry);

    return summary;
  });
}

export async function processAllThanksTokenDemurrage(
  now: Date = new Date(),
): Promise<ThanksTokenDemurrageSummary[]> {
  const owners = await db
    .select({ ownerId: resources.ownerId })
    .from(resources)
    .where(and(eq(resources.type, "thanks_token"), isNull(resources.deletedAt)))
    .groupBy(resources.ownerId);

  const BATCH_SIZE = 50;
  const results: ThanksTokenDemurrageSummary[] = [];
  for (let i = 0; i < owners.length; i += BATCH_SIZE) {
    const chunk = owners.slice(i, i + BATCH_SIZE);
    const chunkResults = await Promise.all(
      chunk.map((owner) => processThanksTokenDemurrageForOwner(owner.ownerId, now))
    );
    results.push(...chunkResults);
  }
  return results;
}
