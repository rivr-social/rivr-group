/**
 * @module lib/settlement-accounting
 *
 * The settlement accounting primitives that were trapped inside
 * `app/api/stripe/webhook/route.ts` (Next.js route files may only export
 * request handlers, so nothing else could import them). Extracted VERBATIM —
 * every function body here is byte-identical to the route's previous private
 * copy — so both the Stripe webhook and the federated settlement receiver
 * credit the ledger through ONE path.
 *
 * These are the low-level pieces: wallet row-locking, inventory consumption,
 * split resolution, and the seller-net credit cascade. The purchase-level
 * orchestration lives in `lib/marketplace-settlement.ts` and
 * `lib/event-ticket-settlement.ts`.
 */
import { db } from '@/db';
import { resources, wallets, walletTransactions, type WalletRecord } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getStripe } from '@/lib/billing';
import {
  getSettlementWalletForAgent,
  getOrCreateProjectWallet,
  creditWalletCapital,
} from '@/lib/wallet';
import { allocateByBps, type SettlementSplit } from '@/lib/settlement-splits';
import { consumeBookingSlot, isBookingSlotAvailable } from '@/lib/booking-slots';

/** The Drizzle transaction handle type used by every settlement primitive. */
export type SettlementTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function getInventoryState(metadata: Record<string, unknown>): {
  quantityAvailable: number | null;
  quantitySold: number;
  quantityRemaining: number | null;
} {
  const quantityAvailable =
    typeof metadata.quantityAvailable === 'number' && Number.isFinite(metadata.quantityAvailable)
      ? metadata.quantityAvailable
      : null;
  const quantitySold =
    typeof metadata.quantitySold === 'number' && Number.isFinite(metadata.quantitySold)
      ? metadata.quantitySold
      : 0;
  const quantityRemaining =
    typeof metadata.quantityRemaining === 'number' && Number.isFinite(metadata.quantityRemaining)
      ? metadata.quantityRemaining
      : quantityAvailable != null
        ? Math.max(quantityAvailable - quantitySold, 0)
        : null;

  return { quantityAvailable, quantitySold, quantityRemaining };
}

export function sortedUniqueWalletIds(walletIds: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      walletIds.filter(
        (walletId): walletId is string => typeof walletId === 'string' && walletId.length > 0,
      ),
    ),
  ).sort();
}

export async function lockWallets(
  tx: SettlementTx,
  walletIds: Array<string | null | undefined>,
): Promise<void> {
  for (const walletId of sortedUniqueWalletIds(walletIds)) {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
  }
}

/**
 * A resolved settlement split paired with its destination wallet.
 *
 * The wallet is fetched (and lazily created, for project treasuries) OUTSIDE
 * the settlement transaction so that every destination can be row-locked up
 * front and the in-transaction credit stays purely additive.
 */
export interface ResolvedSettlementTarget {
  split: SettlementSplit;
  wallet: WalletRecord;
}

/**
 * Resolves a listing/offering's `projectId` from the authoritative resource
 * record (never from client-supplied Stripe metadata) so the settlement
 * cascade is server-trusted.
 */
export async function getResourceProjectId(resourceId: string): Promise<string | null> {
  const [resource] = await db
    .select({ metadata: resources.metadata })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  const projectId = (resource?.metadata as Record<string, unknown> | null | undefined)?.[
    'projectId'
  ];
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/**
 * Materializes each settlement split into its destination wallet. Project
 * splits resolve to the project treasury wallet (created on first settlement);
 * agent splits resolve to the recipient's settlement wallet. Returned in the
 * same order as `splits` so `allocateByBps` output lines up by index.
 */
export async function resolveSettlementTargets(
  splits: SettlementSplit[],
): Promise<ResolvedSettlementTarget[]> {
  const targets: ResolvedSettlementTarget[] = [];
  for (const split of splits) {
    const wallet =
      split.walletKind === 'project' && split.projectResourceId
        ? await getOrCreateProjectWallet(split.projectResourceId, split.ownerAgentId)
        : await getSettlementWalletForAgent(split.ownerAgentId);
    targets.push({ split, wallet });
  }
  return targets;
}

/**
 * Credits the seller-net amount across the resolved settlement targets inside
 * the settlement transaction. Each target's wallet balance is incremented, a
 * `marketplace_payout` wallet transaction is recorded, and a pending capital
 * entry is opened so the share is payout-eligible once Stripe clears the charge.
 *
 * The cent split uses {@link allocateByBps} (largest-remainder, exact-sum) so
 * the distributed cents add up to `sellerCreditCents` with no leakage.
 */
export async function settleSellerNet(
  tx: SettlementTx,
  targets: ResolvedSettlementTarget[],
  sellerCreditCents: number,
  payoutEligibleAt: string | null,
  opts: {
    currency: string;
    referenceId: string;
    ledgerEntryId: string;
    paymentIntentId: string;
    sourceType: string;
    descriptionPrefix: string;
  },
): Promise<void> {
  if (sellerCreditCents <= 0) return;

  const allocations = allocateByBps(
    sellerCreditCents,
    targets.map((t) => t.split),
  );

  for (let i = 0; i < targets.length; i++) {
    const { wallet, split } = targets[i];
    const amountCents = allocations[i].amountCents;
    if (amountCents <= 0) continue;

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    const [payoutTx] = await tx
      .insert(walletTransactions)
      .values({
        type: 'marketplace_payout',
        toWalletId: wallet.id,
        amountCents,
        feeCents: 0,
        currency: opts.currency,
        description: `${opts.descriptionPrefix} ${opts.referenceId}`,
        referenceType: 'resource',
        referenceId: opts.referenceId,
        ledgerEntryId: opts.ledgerEntryId,
        status: 'completed',
        metadata: {
          source: opts.sourceType,
          paymentIntentId: opts.paymentIntentId,
          referenceId: opts.referenceId,
          settlementRole: split.role,
          settlementBps: split.bps,
          walletKind: split.walletKind,
          ownerAgentId: split.ownerAgentId,
          projectResourceId: split.projectResourceId ?? null,
          payoutEligibleAt,
        },
      })
      .returning({ id: walletTransactions.id });

    await creditWalletCapital(tx, wallet.id, amountCents, {
      settlementStatus: 'pending',
      availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
      sourceType: opts.sourceType,
      sourceTransactionId: payoutTx.id,
      metadata: {
        paymentIntentId: opts.paymentIntentId,
        stripePaymentIntentId: opts.paymentIntentId,
        referenceId: opts.referenceId,
        settlementRole: split.role,
        projectResourceId: split.projectResourceId ?? null,
      },
    });
  }
}

export async function incrementListingInventory(
  tx: SettlementTx,
  resourceId: string,
  requestedQuantity: number,
  bookingSelection?: { date: string; slot: string } | null,
): Promise<void> {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) return;

  // Lock the row to prevent concurrent webhooks from reading stale inventory
  const [resource] = await tx.execute(
    sql`SELECT metadata FROM resources WHERE id = ${resourceId} LIMIT 1 FOR UPDATE`
  ) as unknown as { metadata: Record<string, unknown> }[];

  const metadata = (resource?.metadata ?? {}) as Record<string, unknown>;
  if (!isBookingSlotAvailable(metadata, bookingSelection)) {
    throw new Error(`Booking slot unavailable for resource ${resourceId}`);
  }
  const { quantityAvailable, quantitySold, quantityRemaining } = getInventoryState(metadata);
  if (quantityAvailable == null && !bookingSelection) return;

  if (quantityAvailable != null && requestedQuantity > (quantityRemaining ?? 0)) {
    throw new Error(`Inventory exceeded for resource ${resourceId}`);
  }

  const nextQuantitySold = quantitySold + requestedQuantity;
  const nextQuantityRemaining =
    quantityAvailable != null ? Math.max(quantityAvailable - nextQuantitySold, 0) : null;
  const nextMetadata = consumeBookingSlot(metadata, bookingSelection);

  await tx
    .update(resources)
    .set({
      metadata: {
        ...nextMetadata,
        ...(quantityAvailable != null
          ? {
              quantityAvailable,
              quantitySold: nextQuantitySold,
              quantityRemaining: nextQuantityRemaining,
              ...(nextQuantityRemaining === 0 ? { status: 'sold_out' } : {}),
            }
          : {}),
      },
    })
    .where(eq(resources.id, resourceId));
}

export async function getPaymentIntentPayoutEligibleAt(paymentIntentId: string): Promise<string | null> {
  try {
    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });

    const latestCharge =
      paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== 'string'
        ? paymentIntent.latest_charge
        : null;
    const balanceTransaction =
      latestCharge?.balance_transaction &&
      typeof latestCharge.balance_transaction !== 'string'
        ? latestCharge.balance_transaction
        : null;

    if (!balanceTransaction?.available_on) {
      return null;
    }

    return new Date(balanceTransaction.available_on * 1000).toISOString();
  } catch (error) {
    console.error('Failed to fetch payment intent payout eligibility:', paymentIntentId, error);
    return null;
  }
}
