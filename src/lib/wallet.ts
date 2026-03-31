/**
 * Wallet domain service functions for balances, deposits, transfers, purchases,
 * blockchain metadata, and transaction history.
 *
 * Purpose:
 * Implements wallet lifecycle and money-movement workflows with transactional
 * safety (row locking and atomic updates), plus audit trails via ledger rows.
 *
 * Key exports:
 * `getOrCreateWallet`, `getWalletBalance`, `getUserWallets`,
 * `createDepositIntent`, `confirmDeposit`, `failDeposit`, `transferP2P`,
 * `purchaseFromWallet`, `setEthAddress`, `recordEthPayment`,
 * and `getTransactionHistory`.
 *
 * Dependencies:
 * Drizzle DB client/schema, Stripe helpers from `@/lib/billing`,
 * wallet constants, ETH address validation, and currency formatting helpers.
 */
import { db } from '@/db';
import {
  wallets,
  capitalEntries,
  walletTransactions,
  ledger,
  agents,
  type WalletRecord,
  type WalletTransactionRecord,
  type WalletType,
  type WalletTransactionType,
  type CapitalEntryRecord,
  type NewCapitalEntryRecord,
} from '@/db/schema';
import { eq, and, or, sql, isNull, count } from 'drizzle-orm';
import { getStripe, getOrCreateStripeCustomer } from '@/lib/billing';
import { toDollars } from '@/lib/integrations/stripe';
import {
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
  MIN_TRANSFER_CENTS,
  MAX_TRANSFER_CENTS,
  WALLET_TX_STATUS,
} from '@/lib/wallet-constants';
import { isValidEthAddress } from '@/lib/eth-utils';
import type { WalletBalance, WalletTransactionView } from '@/types';

/**
 * Agent types considered "group-like" for group-wallet visibility.
 *
 * Business rule:
 * Agents can access group wallets only when they have an active `join` or
 * `belong` edge to an agent in this allowlist.
 */
const GROUP_AGENT_TYPES = [
  'organization',
  'org',
  'ring',
  'family',
  'guild',
  'community',
] as const;

const DEFAULT_PLATFORM_ORG_NAME = 'RIVR';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sorts two wallet IDs to establish a consistent lock order.
 * Locking in alphabetical ID order prevents deadlocks across concurrent
 * two-wallet transfers/purchases that touch the same rows in opposite order.
 */
function sortedWalletIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function isGroupWalletAgentType(agentType: string | null | undefined): boolean {
  return GROUP_AGENT_TYPES.includes((agentType ?? '').toLowerCase() as typeof GROUP_AGENT_TYPES[number]);
}

function sortedUniqueWalletIds(walletIds: Array<string | null | undefined>): string[] {
  return Array.from(new Set(walletIds.filter((walletId): walletId is string => typeof walletId === 'string' && walletId.length > 0))).sort();
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CapitalConsumption = {
  entryId: string;
  amountCents: number;
  settlementStatus: 'pending' | 'cleared';
  availableOn: string | null;
  metadata: Record<string, unknown>;
};

async function ensureCapitalEntriesCoverWalletBalance(
  tx: DbTx,
  walletId: string,
  walletBalanceCents: number,
): Promise<void> {
  const [coverage] = await tx
    .select({
      coveredCents: sql<number>`coalesce(sum(${capitalEntries.remainingCents}), 0)::int`,
    })
    .from(capitalEntries)
    .where(eq(capitalEntries.walletId, walletId));

  const coveredCents = Number(coverage?.coveredCents ?? 0);
  const missingCents = walletBalanceCents - coveredCents;

  if (missingCents <= 0) return;

  await tx.insert(capitalEntries).values({
    walletId,
    amountCents: missingCents,
    remainingCents: missingCents,
    settlementStatus: 'cleared',
    sourceType: 'legacy_bootstrap',
    metadata: { bootstrapped: true },
  } satisfies NewCapitalEntryRecord);
}

export async function consumeWalletCapital(
  tx: DbTx,
  walletId: string,
  walletBalanceCents: number,
  amountCents: number,
  options?: {
    clearedOnly?: boolean;
  },
): Promise<CapitalConsumption[]> {
  await ensureCapitalEntriesCoverWalletBalance(tx, walletId, walletBalanceCents);

  const entryRows = await tx
    .select()
    .from(capitalEntries)
    .where(
      and(
        eq(capitalEntries.walletId, walletId),
        sql`${capitalEntries.remainingCents} > 0`,
        options?.clearedOnly
          ? sql`(${capitalEntries.settlementStatus} = 'cleared' OR (${capitalEntries.availableOn} IS NOT NULL AND ${capitalEntries.availableOn} <= now()))`
          : sql`true`,
      ),
    )
    .orderBy(
      sql`CASE
        WHEN ${capitalEntries.settlementStatus} = 'cleared' THEN 0
        WHEN ${capitalEntries.availableOn} IS NOT NULL AND ${capitalEntries.availableOn} <= now() THEN 0
        ELSE 1
      END`,
      capitalEntries.availableOn,
      capitalEntries.createdAt,
    );

  const consumptions: CapitalConsumption[] = [];
  let remainingToConsume = amountCents;

  for (const entry of entryRows) {
    if (remainingToConsume <= 0) break;
    const takeCents = Math.min(entry.remainingCents, remainingToConsume);
    if (takeCents <= 0) continue;

    await tx
      .update(capitalEntries)
      .set({
        remainingCents: sql`${capitalEntries.remainingCents} - ${takeCents}`,
        updatedAt: new Date(),
      })
      .where(eq(capitalEntries.id, entry.id));

    consumptions.push({
      entryId: entry.id,
      amountCents: takeCents,
      settlementStatus:
        entry.settlementStatus === 'cleared' ||
        (entry.availableOn && entry.availableOn <= new Date())
          ? 'cleared'
          : 'pending',
      availableOn: entry.availableOn ? entry.availableOn.toISOString() : null,
      metadata: (entry.metadata ?? {}) as Record<string, unknown>,
    });
    remainingToConsume -= takeCents;
  }

  if (remainingToConsume > 0) {
    throw new Error(
      options?.clearedOnly
        ? `Insufficient cleared capital balance: need ${amountCents} cents`
        : `Insufficient capital balance: need ${amountCents} cents`,
    );
  }

  return consumptions;
}

export async function restoreWalletCapitalFromConsumptions(
  tx: DbTx,
  walletId: string,
  consumptions: CapitalConsumption[],
  options?: {
    sourceType: string;
    sourceTransactionId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (consumptions.length === 0) return;

  await tx.insert(capitalEntries).values(
    consumptions.map((consumption) => ({
      walletId,
      sourceEntryId: consumption.entryId,
      sourceTransactionId: options?.sourceTransactionId ?? null,
      amountCents: consumption.amountCents,
      remainingCents: consumption.amountCents,
      settlementStatus: consumption.settlementStatus,
      availableOn: consumption.availableOn ? new Date(consumption.availableOn) : null,
      sourceType: options?.sourceType ?? 'transfer',
      metadata: {
        ...consumption.metadata,
        ...(options?.metadata ?? {}),
      },
    })),
  );
}

export async function creditWalletCapital(
  tx: DbTx,
  walletId: string,
  amountCents: number,
  options: {
    settlementStatus: 'pending' | 'cleared';
    availableOn?: Date | null;
    sourceType: string;
    sourceTransactionId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (amountCents <= 0) return;

  await tx.insert(capitalEntries).values({
    walletId,
    amountCents,
    remainingCents: amountCents,
    settlementStatus: options.settlementStatus,
    availableOn: options.availableOn ?? null,
    sourceType: options.sourceType,
    sourceTransactionId: options.sourceTransactionId ?? null,
    metadata: options.metadata ?? {},
  });
}

export async function getWalletPayoutAvailabilityFromEntries(
  walletId: string,
  currentBalanceCents: number,
): Promise<{
  payoutEligibleCents: number;
  pendingSettlementCents: number;
}> {
  const [pendingSettlementResult] = await db
    .select({
      amountCents: sql<number>`coalesce(sum(${capitalEntries.remainingCents}), 0)::int`,
    })
    .from(capitalEntries)
    .where(
      and(
        eq(capitalEntries.walletId, walletId),
        sql`${capitalEntries.remainingCents} > 0`,
        sql`${capitalEntries.settlementStatus} = 'pending'`,
        sql`(${capitalEntries.availableOn} IS NULL OR ${capitalEntries.availableOn} > now())`,
      ),
    );

  const pendingSettlementCents = Math.max(0, Number(pendingSettlementResult?.amountCents ?? 0));
  return {
    payoutEligibleCents: Math.max(0, currentBalanceCents - pendingSettlementCents),
    pendingSettlementCents,
  };
}

function splitConsumptionsByAmount(
  consumptions: CapitalConsumption[],
  primaryAmountCents: number,
): {
  primary: CapitalConsumption[];
  secondary: CapitalConsumption[];
} {
  const primary: CapitalConsumption[] = [];
  const secondary: CapitalConsumption[] = [];
  let remainingPrimary = primaryAmountCents;

  for (const consumption of consumptions) {
    if (remainingPrimary <= 0) {
      secondary.push(consumption);
      continue;
    }

    const primaryTake = Math.min(consumption.amountCents, remainingPrimary);
    const secondaryTake = consumption.amountCents - primaryTake;

    if (primaryTake > 0) {
      primary.push({ ...consumption, amountCents: primaryTake });
      remainingPrimary -= primaryTake;
    }

    if (secondaryTake > 0) {
      secondary.push({ ...consumption, amountCents: secondaryTake });
    }
  }

  return { primary, secondary };
}

async function getAgentWalletType(agentId: string): Promise<WalletType> {
  const [agent] = await db
    .select({ type: agents.type })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return isGroupWalletAgentType(agent.type) ? 'group' : 'personal';
}

export async function getSettlementWalletForAgent(agentId: string): Promise<WalletRecord> {
  const walletType = await getAgentWalletType(agentId);
  return getOrCreateWallet(agentId, walletType);
}

export async function getPlatformWallet(): Promise<WalletRecord> {
  const configuredOwnerId = process.env.PLATFORM_AGENT_ID?.trim();

  if (configuredOwnerId) {
    return getSettlementWalletForAgent(configuredOwnerId);
  }

  const [platformOrg] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.type, 'organization'),
        eq(agents.name, DEFAULT_PLATFORM_ORG_NAME),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!platformOrg) {
    throw new Error(
      'Platform fee settlement target is not configured. Set PLATFORM_AGENT_ID or create an active "RIVR" organization agent.',
    );
  }

  return getOrCreateWallet(platformOrg.id, 'group');
}

// ---------------------------------------------------------------------------
// 1. getOrCreateWallet
// ---------------------------------------------------------------------------

/**
 * Returns the wallet for the given agent and type, creating one if it
 * does not exist.  For personal wallets the Stripe customer ID is
 * resolved and stored on the wallet row.
 *
 * @param agentId Agent that owns the wallet.
 * @param type Wallet type to fetch or create (`personal` by default).
 * @returns Existing or newly created wallet row.
 * @throws {Error} When Stripe customer creation or database operations fail.
 * @example
 * ```ts
 * const personal = await getOrCreateWallet(agentId);
 * const group = await getOrCreateWallet(groupId, 'group');
 * ```
 */
export async function getOrCreateWallet(
  agentId: string,
  type: WalletType = 'personal',
): Promise<WalletRecord> {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.ownerId, agentId), eq(wallets.type, type)))
    .limit(1);

  if (existing) {
    return existing;
  }

  let stripeCustomerId: string | null = null;
  if (type === 'personal') {
    // Personal wallets need a Stripe customer for card-based deposits.
    stripeCustomerId = await getOrCreateStripeCustomer(agentId);
  }

  // Use ON CONFLICT DO NOTHING to handle concurrent inserts safely.
  // The unique index on (ownerId, type) prevents duplicates.
  const inserted = await db
    .insert(wallets)
    .values({
      ownerId: agentId,
      type,
      stripeCustomerId,
    })
    .onConflictDoNothing({
      target: [wallets.ownerId, wallets.type],
    })
    .returning();

  if (inserted.length > 0) {
    return inserted[0];
  }

  // Another concurrent call won the insert — re-select the existing row.
  const [raced] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.ownerId, agentId), eq(wallets.type, type)))
    .limit(1);

  return raced;
}

// ---------------------------------------------------------------------------
// 2. getWalletBalance
// ---------------------------------------------------------------------------

/**
 * Fetches a single wallet's balance view including the owner's display name.
 *
 * @param walletId Wallet identifier.
 * @returns Normalized wallet balance DTO with both cents and dollar fields.
 * @throws {Error} When the wallet does not exist.
 * @example
 * ```ts
 * const balance = await getWalletBalance(walletId);
 * console.log(balance.balanceDollars);
 * ```
 */
export async function getWalletBalance(walletId: string): Promise<WalletBalance> {
  const [row] = await db
    .select({
      walletId: wallets.id,
      ownerId: wallets.ownerId,
      ownerName: agents.name,
      type: wallets.type,
      balanceCents: wallets.balanceCents,
      currency: wallets.currency,
      ethAddress: wallets.ethAddress,
      isFrozen: wallets.isFrozen,
    })
    .from(wallets)
    .innerJoin(agents, eq(wallets.ownerId, agents.id))
    .where(eq(wallets.id, walletId))
    .limit(1);

  if (!row) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  return {
    walletId: row.walletId,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    type: row.type,
    balanceCents: row.balanceCents,
    balanceDollars: toDollars(row.balanceCents),
    currency: row.currency,
    ethAddress: row.ethAddress ?? undefined,
    isFrozen: row.isFrozen,
  };
}

// ---------------------------------------------------------------------------
// 3. getUserWallets
// ---------------------------------------------------------------------------

/**
 * Returns wallets accessible to the given agent:
 *   - their personal wallet
 *   - any group wallets for groups they belong to or have joined
 *
 * @param agentId Agent requesting wallet access.
 * @returns Wallet summaries for personal + eligible group wallets.
 * @throws {Error} When wallet creation/read operations fail.
 * @example
 * ```ts
 * const wallets = await getUserWallets(agentId);
 * ```
 */
export async function getUserWallets(agentId: string): Promise<WalletBalance[]> {
  // Ensure the personal wallet exists
  await getOrCreateWallet(agentId, 'personal');

  // Find groups where the agent has an active join/belong edge
  const groupEdges = await db
    .select({ objectId: ledger.objectId })
    .from(ledger)
    .innerJoin(agents, eq(ledger.objectId, agents.id))
    .where(
      and(
        eq(ledger.subjectId, agentId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, 'join'), eq(ledger.verb, 'belong')),
        or(
          ...GROUP_AGENT_TYPES.map((t) => eq(agents.type, t)),
        ),
      ),
    );

  const groupOwnerIds = groupEdges
    .map((e) => e.objectId)
    .filter((id): id is string => id !== null);

  // Collect all owner IDs whose wallets we need.
  // Kept as a named variable to document access scope intent.
  const ownerIds = [agentId, ...groupOwnerIds];

  // Fetch all matching wallets in a single query
  const rows = await db
    .select({
      walletId: wallets.id,
      ownerId: wallets.ownerId,
      ownerName: agents.name,
      type: wallets.type,
      balanceCents: wallets.balanceCents,
      currency: wallets.currency,
      ethAddress: wallets.ethAddress,
      isFrozen: wallets.isFrozen,
    })
    .from(wallets)
    .innerJoin(agents, eq(wallets.ownerId, agents.id))
    .where(
      or(
        // Personal wallet for the user
        and(eq(wallets.ownerId, agentId), eq(wallets.type, 'personal')),
        // Group wallets for groups the user belongs to
        ...(groupOwnerIds.length > 0
          ? groupOwnerIds.map((gid) =>
              and(eq(wallets.ownerId, gid), eq(wallets.type, 'group')),
            )
          : []),
      ),
    );

  return rows.map((row) => ({
    walletId: row.walletId,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    type: row.type,
    balanceCents: row.balanceCents,
    balanceDollars: toDollars(row.balanceCents),
    currency: row.currency,
    ethAddress: row.ethAddress ?? undefined,
    isFrozen: row.isFrozen,
  }));
}

// ---------------------------------------------------------------------------
// 4. createDepositIntent
// ---------------------------------------------------------------------------

/**
 * Creates a Stripe PaymentIntent for depositing funds into a wallet.
 * Records a pending transaction row that will be confirmed or failed
 * by the Stripe webhook handler.
 *
 * @param walletId Destination wallet to credit after webhook confirmation.
 * @param amountCents Deposit amount in cents.
 * @returns Stripe client secret + PaymentIntent ID.
 * @throws {Error} When amount limits fail, wallet is missing/frozen, or Stripe/DB calls fail.
 * @example
 * ```ts
 * const intent = await createDepositIntent(walletId, 25_00);
 * ```
 */
export async function createDepositIntent(
  walletId: string,
  amountCents: number,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  if (amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    throw new Error(
      `Deposit amount must be between ${MIN_DEPOSIT_CENTS} and ${MAX_DEPOSIT_CENTS} cents`,
    );
  }

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);

  if (!wallet) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  if (wallet.isFrozen) {
    throw new Error('Cannot deposit to a frozen wallet');
  }

  const stripe = getStripe();

  // Wallet ID in metadata lets webhook handlers safely correlate callbacks
  // with internal records without trusting client-provided identifiers.
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: wallet.stripeCustomerId ?? undefined,
    metadata: { walletId },
  });

  await db.insert(walletTransactions).values({
    type: 'stripe_deposit',
    toWalletId: walletId,
    amountCents,
    currency: 'usd',
    description: 'Wallet deposit via Stripe',
    stripePaymentIntentId: paymentIntent.id,
    status: WALLET_TX_STATUS.PENDING,
  });

  if (!paymentIntent.client_secret) {
    throw new Error('Stripe returned a PaymentIntent without a client_secret');
  }

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

// ---------------------------------------------------------------------------
// 5. confirmDeposit
// ---------------------------------------------------------------------------

/**
 * Confirms a previously-pending Stripe deposit.
 * Called by the webhook handler when the PaymentIntent succeeds.
 *
 * Idempotent: returns null if the transaction is already completed or
 * cannot be found.
 *
 * @param paymentIntentId Stripe PaymentIntent identifier from webhook event.
 * @returns Completed wallet transaction row, or `null` when no pending match exists.
 * @throws {Error} When database operations fail unexpectedly.
 * @example
 * ```ts
 * const tx = await confirmDeposit(paymentIntentId);
 * if (tx) console.log(tx.id);
 * ```
 */
export async function confirmDeposit(
  paymentIntentId: string,
): Promise<WalletTransactionRecord | null> {
  return await db.transaction(async (tx) => {
    // Find the pending transaction
    const [pendingTx] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!pendingTx || pendingTx.status !== WALLET_TX_STATUS.PENDING) {
      return null;
    }

    const toWalletId = pendingTx.toWalletId;
    if (!toWalletId) {
      return null;
    }

    // Row-level lock prevents concurrent credits/races from double-applying
    // balance updates while this transaction is in-flight.
    const [lockedWallet] = await tx.execute(
      sql`SELECT id, is_frozen FROM wallets WHERE id = ${toWalletId} FOR UPDATE`,
    ) as unknown as [{ id: string; is_frozen: boolean }];

    if (lockedWallet?.is_frozen) {
      // Mark the transaction as failed instead of crediting a frozen wallet.
      await tx
        .update(walletTransactions)
        .set({ status: WALLET_TX_STATUS.FAILED })
        .where(eq(walletTransactions.id, pendingTx.id));
      return null;
    }

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${pendingTx.amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, toWalletId));

    // Insert a ledger entry recording the deposit
    const [walletRow] = await tx
      .select({ ownerId: wallets.ownerId })
      .from(wallets)
      .where(eq(wallets.id, toWalletId))
      .limit(1);

    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'fund',
        subjectId: walletRow.ownerId,
        objectId: toWalletId,
        objectType: 'wallet',
        metadata: {
          amountCents: pendingTx.amountCents,
          stripePaymentIntentId: paymentIntentId,
        },
      })
      .returning();

    // Mark transaction as completed
    const [updatedTx] = await tx
      .update(walletTransactions)
      .set({
        status: WALLET_TX_STATUS.COMPLETED,
        ledgerEntryId: ledgerEntry.id,
      })
      .where(eq(walletTransactions.id, pendingTx.id))
      .returning();

    await creditWalletCapital(tx, toWalletId, pendingTx.amountCents, {
      settlementStatus: 'cleared',
      sourceType: 'stripe_deposit',
      sourceTransactionId: updatedTx.id,
      metadata: {
        stripePaymentIntentId: paymentIntentId,
      },
    });

    return updatedTx;
  });
}

// ---------------------------------------------------------------------------
// 6. failDeposit
// ---------------------------------------------------------------------------

/**
 * Marks a pending Stripe deposit transaction as failed.
 * Called by the webhook handler when the PaymentIntent fails.
 *
 * @param paymentIntentId Stripe PaymentIntent identifier from webhook event.
 * @returns Resolves when the update is applied.
 * @throws {Error} When database updates fail.
 * @example
 * ```ts
 * await failDeposit(paymentIntentId);
 * ```
 */
export async function failDeposit(paymentIntentId: string): Promise<void> {
  await db
    .update(walletTransactions)
    .set({ status: WALLET_TX_STATUS.FAILED })
    .where(
      and(
        eq(walletTransactions.stripePaymentIntentId, paymentIntentId),
        eq(walletTransactions.status, WALLET_TX_STATUS.PENDING),
      ),
    );
}

// ---------------------------------------------------------------------------
// 7. transferP2P
// ---------------------------------------------------------------------------

/**
 * Transfers funds between two wallets (peer-to-peer).
 * Locks wallets in ID order to prevent deadlocks.
 *
 * @param fromWalletId Sender wallet to debit.
 * @param toWalletId Receiver wallet to credit.
 * @param amountCents Transfer amount in cents.
 * @param description Human-readable transfer description.
 * @returns Completed wallet transaction row.
 * @throws {Error} When validation fails, source wallet is missing/frozen, or balance is insufficient.
 * @example
 * ```ts
 * const tx = await transferP2P(senderWalletId, receiverWalletId, 15_00, 'Lunch split');
 * ```
 */
export async function transferP2P(
  fromWalletId: string,
  toWalletId: string,
  amountCents: number,
  description: string,
): Promise<WalletTransactionRecord> {
  if (amountCents < MIN_TRANSFER_CENTS || amountCents > MAX_TRANSFER_CENTS) {
    throw new Error(
      `Transfer amount must be between ${MIN_TRANSFER_CENTS} and ${MAX_TRANSFER_CENTS} cents`,
    );
  }

  if (fromWalletId === toWalletId) {
    throw new Error('Cannot transfer to the same wallet');
  }

  return await db.transaction(async (tx) => {
    // Lock wallets in sorted ID order to prevent deadlocks
    const [firstId, secondId] = sortedWalletIds(fromWalletId, toWalletId);
    await tx.execute(
      sql`SELECT id FROM wallets WHERE id = ${firstId} FOR UPDATE`,
    );
    await tx.execute(
      sql`SELECT id FROM wallets WHERE id = ${secondId} FOR UPDATE`,
    );

    // Read after lock to ensure balance/frozen checks are based on a consistent
    // row version inside this transaction.
    const [fromWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.id, fromWalletId))
      .limit(1);

    if (!fromWallet) {
      throw new Error(`Source wallet not found: ${fromWalletId}`);
    }

    if (fromWallet.isFrozen) {
      throw new Error('Cannot transfer from a frozen wallet');
    }

    if (fromWallet.balanceCents < amountCents) {
      throw new Error(
        `Insufficient balance: have ${fromWallet.balanceCents} cents, need ${amountCents} cents`,
      );
    }

    const consumptions = await consumeWalletCapital(
      tx,
      fromWalletId,
      fromWallet.balanceCents,
      amountCents,
    );

    // Debit sender
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, fromWalletId));

    // Credit receiver
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, toWalletId));

    // Ledger entry
    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'transact',
        subjectId: fromWallet.ownerId,
        objectId: toWalletId,
        objectType: 'wallet',
        metadata: {
          amountCents,
          fromWalletId,
          toWalletId,
          description,
        },
      })
      .returning();

    // Transaction record
    const [transaction] = await tx
      .insert(walletTransactions)
      .values({
        type: 'p2p_transfer',
        fromWalletId,
        toWalletId,
        amountCents,
        currency: 'usd',
        description,
        status: WALLET_TX_STATUS.COMPLETED,
        ledgerEntryId: ledgerEntry.id,
      })
      .returning();

    await restoreWalletCapitalFromConsumptions(tx, toWalletId, consumptions, {
      sourceType: 'p2p_transfer',
      sourceTransactionId: transaction.id,
      metadata: {
        fromWalletId,
        toWalletId,
      },
    });

    return transaction;
  });
}

// ---------------------------------------------------------------------------
// 8. purchaseFromWallet
// ---------------------------------------------------------------------------

/**
 * Processes a marketplace purchase: debits the buyer, credits the seller
 * (minus the service fee), and records both transactions.
 *
 * @param buyerWalletId Buyer wallet debited for the full purchase amount.
 * @param sellerWalletId Seller wallet credited for amount minus fee.
 * @param amountCents Gross purchase amount in cents.
 * @param feeCents Marketplace/service fee in cents.
 * @param referenceType Domain entity type associated with this purchase.
 * @param referenceId Domain entity identifier associated with this purchase.
 * @param description Human-readable purchase description.
 * @returns Primary marketplace purchase transaction row.
 * @throws {Error} When wallets are invalid, buyer is frozen, or funds are insufficient.
 * @example
 * ```ts
 * const tx = await purchaseFromWallet(
 *   buyerWalletId,
 *   sellerWalletId,
 *   50_00,
 *   5_00,
 *   'listing',
 *   listingId,
 *   'Ticket purchase',
 * );
 * ```
 */
export async function purchaseFromWallet(
  buyerWalletId: string,
  sellerWalletId: string,
  amountCents: number,
  feeCents: number,
  referenceType: string,
  referenceId: string,
  description: string,
  feeRecipientWalletId?: string | null,
  externalTx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<WalletTransactionRecord> {
  if (buyerWalletId === sellerWalletId) {
    throw new Error('Buyer and seller wallets must be different');
  }

  if (amountCents <= 0) {
    throw new Error('Purchase amount must be positive');
  }

  if (feeCents < 0 || feeCents > amountCents) {
    throw new Error('Fee must be between 0 and the purchase amount');
  }

  if (feeCents > 0 && !feeRecipientWalletId) {
    throw new Error('Fee recipient wallet is required when a purchase includes fees');
  }

  const sellerCreditCents = amountCents - feeCents;

  const execute = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    // Lock all touched wallets in deterministic order to avoid deadlocks.
    for (const walletId of sortedUniqueWalletIds([
      buyerWalletId,
      sellerWalletId,
      feeRecipientWalletId,
    ])) {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
    }

    // Read buyer wallet after lock
    const [buyerWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.id, buyerWalletId))
      .limit(1);

    if (!buyerWallet) {
      throw new Error(`Buyer wallet not found: ${buyerWalletId}`);
    }

    if (buyerWallet.isFrozen) {
      throw new Error('Cannot purchase from a frozen wallet');
    }

    if (buyerWallet.balanceCents < amountCents) {
      throw new Error(
        `Insufficient balance: have ${buyerWallet.balanceCents} cents, need ${amountCents} cents`,
      );
    }

    const consumptions = await consumeWalletCapital(
      tx,
      buyerWalletId,
      buyerWallet.balanceCents,
      amountCents,
    );
    const { primary: sellerConsumptions, secondary: feeConsumptions } =
      splitConsumptionsByAmount(consumptions, sellerCreditCents);

    // Debit buyer the full amount
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, buyerWalletId));

    // Credit seller with the net purchase amount.
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${sellerCreditCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, sellerWalletId));

    // Ledger entry for the purchase
    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'buy',
        subjectId: buyerWallet.ownerId,
        objectId: sellerWalletId,
        objectType: 'wallet',
        metadata: {
          amountCents,
          feeCents,
          referenceType,
          referenceId,
          description,
        },
      })
      .returning();

    // Purchase transaction
    const [purchaseTx] = await tx
      .insert(walletTransactions)
      .values({
        type: 'marketplace_purchase',
        fromWalletId: buyerWalletId,
        toWalletId: sellerWalletId,
        amountCents,
        feeCents,
        currency: 'usd',
        description,
        referenceType,
        referenceId,
        status: WALLET_TX_STATUS.COMPLETED,
        ledgerEntryId: ledgerEntry.id,
      })
      .returning();

    await restoreWalletCapitalFromConsumptions(tx, sellerWalletId, sellerConsumptions, {
      sourceType: 'marketplace_purchase',
      sourceTransactionId: purchaseTx.id,
      metadata: {
        referenceType,
        referenceId,
        description,
      },
    });

    // Route the fee into the platform-owned wallet so internal settlement
    // matches external accounting instead of silently burning the fee.
    if (feeCents > 0 && feeRecipientWalletId) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${feeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, feeRecipientWalletId));

      await tx.insert(walletTransactions).values({
        type: 'service_fee',
        fromWalletId: buyerWalletId,
        toWalletId: feeRecipientWalletId,
        amountCents: feeCents,
        currency: 'usd',
        description: `Service fee for ${referenceType}`,
        referenceType,
        referenceId,
        status: WALLET_TX_STATUS.COMPLETED,
        ledgerEntryId: ledgerEntry.id,
      });

      await restoreWalletCapitalFromConsumptions(tx, feeRecipientWalletId, feeConsumptions, {
        sourceType: 'service_fee',
        metadata: {
          referenceType,
          referenceId,
          description,
        },
      });
    }

    return purchaseTx;
  };

  if (externalTx) {
    return await execute(externalTx);
  }
  return await db.transaction(execute);
}

// ---------------------------------------------------------------------------
// 9. setEthAddress
// ---------------------------------------------------------------------------

/**
 * Sets the Ethereum address on a wallet after EIP-55 validation.
 *
 * @param walletId Wallet identifier to update.
 * @param ethAddress Candidate Ethereum address.
 * @returns Resolves when update succeeds.
 * @throws {Error} When address format/checksum is invalid or wallet is missing.
 * @example
 * ```ts
 * await setEthAddress(walletId, '0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
 * ```
 */
export async function setEthAddress(
  walletId: string,
  ethAddress: string,
): Promise<void> {
  if (!isValidEthAddress(ethAddress)) {
    throw new Error(`Invalid Ethereum address: ${ethAddress}`);
  }

  const result = await db
    .update(wallets)
    .set({ ethAddress, updatedAt: new Date() })
    .where(eq(wallets.id, walletId))
    .returning({ id: wallets.id });

  if (result.length === 0) {
    throw new Error(`Wallet not found: ${walletId}`);
  }
}

// ---------------------------------------------------------------------------
// 10. recordEthPayment
// ---------------------------------------------------------------------------

/**
 * Records an ETH payment without modifying any wallet balance.
 * Creates a wallet transaction and ledger entry for audit purposes.
 *
 * @param fromWalletId Internal source wallet that initiated payment.
 * @param toWalletId Optional internal destination wallet, when known.
 * @param amountCents Fiat-denominated value in cents for reporting.
 * @param ethTxHash Blockchain transaction hash.
 * @param description Human-readable payment description.
 * @returns Created wallet transaction audit row.
 * @throws {Error} When source wallet is missing or persistence fails.
 * @example
 * ```ts
 * const tx = await recordEthPayment(fromWalletId, null, 120_00, hash, 'On-chain payout');
 * ```
 */
export async function recordEthPayment(
  fromWalletId: string,
  toWalletId: string | null,
  amountCents: number,
  ethTxHash: string,
  description: string,
): Promise<WalletTransactionRecord> {
  const [fromWallet] = await db
    .select({ ownerId: wallets.ownerId })
    .from(wallets)
    .where(eq(wallets.id, fromWalletId))
    .limit(1);

  if (!fromWallet) {
    throw new Error(`Source wallet not found: ${fromWalletId}`);
  }

  // This path intentionally does not mutate balances because settlement
  // happened on-chain; local records are for audit/history only.
  const [ledgerEntry] = await db
    .insert(ledger)
    .values({
      verb: 'transact',
      subjectId: fromWallet.ownerId,
      objectId: toWalletId,
      objectType: 'wallet',
      metadata: {
        amountCents,
        ethTxHash,
        description,
        paymentMethod: 'eth',
      },
    })
    .returning();

  const [transaction] = await db
    .insert(walletTransactions)
    .values({
      type: 'eth_record',
      fromWalletId,
      toWalletId,
      amountCents,
      currency: 'usd',
      description,
      ethTxHash,
      status: WALLET_TX_STATUS.COMPLETED,
      ledgerEntryId: ledgerEntry.id,
    })
    .returning();

  return transaction;
}

// ---------------------------------------------------------------------------
// 11. getTransactionHistory
// ---------------------------------------------------------------------------

/**
 * Fetches paginated transaction history for a wallet, with optional type
 * filter.  Joins to resolve the sender / receiver owner names.
 *
 * @param walletId Wallet whose inbound/outbound transactions are requested.
 * @param options Pagination and optional transaction-type filter.
 * @returns Paginated transaction views plus total matching count.
 * @throws {Error} When database operations fail.
 * @example
 * ```ts
 * const page = await getTransactionHistory(walletId, { limit: 25, offset: 0 });
 * ```
 */
export async function getTransactionHistory(
  walletId: string,
  options?: { limit?: number; offset?: number; type?: WalletTransactionType },
): Promise<{ transactions: WalletTransactionView[]; total: number }> {
  const pageLimit = options?.limit ?? 25;
  const pageOffset = options?.offset ?? 0;

  // Aliases for the from/to wallet owner joins
  const fromOwner = db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .as('from_owner');

  const toOwner = db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .as('to_owner');

  // Build the base filter: this wallet is either sender or receiver
  const walletFilter = or(
    eq(walletTransactions.fromWalletId, walletId),
    eq(walletTransactions.toWalletId, walletId),
  );

  // Optional type filtering is composed into the same predicate used for
  // both count and page queries to keep pagination metadata consistent.
  const typeFilter = options?.type
    ? and(walletFilter, eq(walletTransactions.type, options.type))
    : walletFilter;

  // Count query mirrors the exact row predicate used by the page query.
  const [countRow] = await db
    .select({ value: count() })
    .from(walletTransactions)
    .where(typeFilter!);

  const total = countRow?.value ?? 0;

  // Create aliased tables for from/to wallets
  const fromWallets = db
    .select({ id: wallets.id, ownerId: wallets.ownerId })
    .from(wallets)
    .as('from_wallets');

  const toWallets = db
    .select({ id: wallets.id, ownerId: wallets.ownerId })
    .from(wallets)
    .as('to_wallets');

  // Transaction rows with owner names
  const rows = await db
    .select({
      id: walletTransactions.id,
      type: walletTransactions.type,
      amountCents: walletTransactions.amountCents,
      feeCents: walletTransactions.feeCents,
      description: walletTransactions.description,
      status: walletTransactions.status,
      createdAt: walletTransactions.createdAt,
      ethTxHash: walletTransactions.ethTxHash,
      stripePaymentIntentId: walletTransactions.stripePaymentIntentId,
      fromOwnerName: fromOwner.name,
      toOwnerName: toOwner.name,
    })
    .from(walletTransactions)
    .leftJoin(fromWallets, eq(walletTransactions.fromWalletId, fromWallets.id))
    .leftJoin(fromOwner, eq(fromWallets.ownerId, fromOwner.id))
    .leftJoin(toWallets, eq(walletTransactions.toWalletId, toWallets.id))
    .leftJoin(toOwner, eq(toWallets.ownerId, toOwner.id))
    .where(typeFilter!)
    .orderBy(sql`${walletTransactions.createdAt} DESC`)
    .limit(pageLimit)
    .offset(pageOffset);

  const transactions: WalletTransactionView[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    amountCents: r.amountCents,
    amountDollars: toDollars(r.amountCents),
    feeCents: r.feeCents,
    description: r.description,
    fromWalletOwnerName: r.fromOwnerName ?? undefined,
    toWalletOwnerName: r.toOwnerName ?? undefined,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    ethTxHash: r.ethTxHash ?? undefined,
    stripePaymentIntentId: r.stripePaymentIntentId ?? undefined,
  }));

  return { transactions, total };
}
