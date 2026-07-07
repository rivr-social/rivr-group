'use server';

/**
 * Treasury funds — named sub-pools of the group's main treasury
 * ("Operations Fund", "Land Fund", …) with internal ledger transfers and a
 * Stripe-FinancialAccount-READY banking binding per fund.
 *
 * Model (mirrors the project-wallet + subgroup-banking lanes):
 * - A fund is a `resources` row (`type: 'resource'`, metadata
 *   `resourceKind: 'fund'`, `groupId`, `assignedSubgroupIds`) owned by the
 *   group agent. The `resource_type` pg enum has no `fund` value and enum
 *   additions require a migration (auto-migrate is broken fleet-wide), so the
 *   generic `resource` type + the ecosystem's `metadata.resourceKind`
 *   convention is authoritative here.
 * - Each fund carries exactly ONE wallet, bound via `wallets.resourceId`
 *   through {@link getOrCreateProjectWallet} (partial unique index
 *   `wallets_resource_id_unique_idx`). The wallet keeps `type: 'project'`
 *   (adding a `fund` wallet_type would also be an enum migration) and is
 *   discriminated by `metadata.walletKind: 'fund'`.
 * - Money moves between the group settlement wallet and a fund wallet through
 *   {@link transferP2P} — the existing locked, capital-tracked internal
 *   transfer (no new ledger logic).
 * - Banking stays dormant behind STRIPE_TREASURY_ENABLED /
 *   STRIPE_ISSUING_ENABLED exactly like treasury-banking.ts; FA/cardholder
 *   ids persist on the FUND WALLET metadata (`stripeFinancialAccountId`,
 *   `stripeHostConnectAccountId`, `stripeIssuingCardholderId`).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, resources, wallets } from '@/db/schema';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  MIN_TRANSFER_CENTS,
  MAX_TRANSFER_CENTS,
} from '@/lib/wallet-constants';
import {
  getOrCreateProjectWallet,
  getSettlementWalletForAgent,
  transferP2P,
} from '@/lib/wallet';
import {
  createIssuingCardholder,
  createTreasuryFinancialAccount,
  createTreasuryIssuingCard,
  getTreasuryFinancialAccountBalance,
  isIssuingEnabled,
  isTreasuryEnabled,
  listIssuingCardsForCardholder,
  type IssuedCardSummary,
} from '@/lib/stripe-treasury';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isUuid, isPositiveInteger } from './types';

// ---------------------------------------------------------------------------
// Constants ("use server" files must not export const objects — keep private)
// ---------------------------------------------------------------------------

/** `resources.type` used for fund rows (`fund` is not in the pg enum). */
const FUND_RESOURCE_TYPE = 'resource';
/** `metadata.resourceKind` discriminator for fund resources. */
const FUND_RESOURCE_KIND = 'fund';
/** `metadata.walletKind` discriminator on the fund's bound wallet. */
const FUND_WALLET_KIND = 'fund';
/** `metadata.treasuryKind` stamped on Stripe objects created for a fund. */
const FUND_TREASURY_KIND = 'fund';
/** Maximum fund name length (matches typical resource-name form limits). */
const FUND_NAME_MAX_LENGTH = 120;
/** Default monthly card limit — same platform liability control as subgroups. */
const DEFAULT_FUND_CARD_MONTHLY_LIMIT_CENTS = 50_000; // $500/month

/** Direction of an internal main-treasury <-> fund transfer. */
export type FundTransferDirection = 'to_fund' | 'to_main';

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

interface WalletRow {
  id: string;
  balanceCents: number;
  metadata: Record<string, unknown>;
}

interface FundResourceRow {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface TreasuryFundRow {
  fundId: string;
  name: string;
  description: string | null;
  archived: boolean;
  balanceCents: number;
  assignedSubgroups: { id: string; name: string }[];
  financialAccountId: string | null;
  faCashCents: number | null;
  cards: IssuedCardSummary[];
}

export interface FundSubgroupOption {
  id: string;
  name: string;
  /** Fund the subgroup is currently assigned to, or null when unassigned. */
  assignedFundId: string | null;
}

export interface GroupTreasuryFundsOverview {
  treasuryEnabled: boolean;
  issuingEnabled: boolean;
  groupConnectAccountId: string | null;
  /** Balance of the group's main settlement wallet, in cents. */
  mainTreasuryBalanceCents: number;
  funds: TreasuryFundRow[];
  /** Every live subgroup with its current fund assignment (for the UI select). */
  subgroups: FundSubgroupOption[];
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

async function getWalletRow(walletId: string): Promise<WalletRow> {
  const [wallet] = await db
    .select({ id: wallets.id, balanceCents: wallets.balanceCents, metadata: wallets.metadata })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);
  if (!wallet) throw new Error('Treasury wallet not found.');
  return {
    id: wallet.id,
    balanceCents: wallet.balanceCents,
    metadata: (wallet.metadata ?? {}) as Record<string, unknown>,
  };
}

/** Coerces the fund's `assignedSubgroupIds` metadata into a clean string[]. */
function readAssignedSubgroupIds(metadata: Record<string, unknown>): string[] {
  const raw = metadata.assignedSubgroupIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function readArchived(metadata: Record<string, unknown>): boolean {
  return metadata.archived === true;
}

/** Every fund resource of the group (archived included), newest last. */
async function listFundResources(groupId: string): Promise<FundResourceRow[]> {
  const rows = await db
    .select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, groupId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->>'resourceKind' = ${FUND_RESOURCE_KIND}`,
        sql`${resources.metadata}->>'groupId' = ${groupId}`,
      ),
    )
    .orderBy(resources.createdAt);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** Fetch one fund and verify it really is a fund belonging to this group. */
async function getFundResource(groupId: string, fundId: string): Promise<FundResourceRow> {
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, fundId), isNull(resources.deletedAt)))
    .limit(1);

  if (!row) throw new Error('Fund not found.');
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (metadata.resourceKind !== FUND_RESOURCE_KIND || metadata.groupId !== groupId) {
    throw new Error('That resource is not a fund of this group.');
  }
  return { id: row.id, name: row.name, description: row.description, metadata };
}

/**
 * The fund's bound wallet (created on demand). Reuses the resource-bound
 * project-wallet rail and stamps `metadata.walletKind: 'fund'` so fund wallets
 * stay distinguishable from project treasuries in every downstream read.
 */
async function getOrCreateFundWallet(fundResourceId: string, groupId: string): Promise<WalletRow> {
  const wallet = await getOrCreateProjectWallet(fundResourceId, groupId);
  const metadata = (wallet.metadata ?? {}) as Record<string, unknown>;
  if (metadata.walletKind !== FUND_WALLET_KIND) {
    await db
      .update(wallets)
      .set({
        metadata: { ...metadata, walletKind: FUND_WALLET_KIND },
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));
    metadata.walletKind = FUND_WALLET_KIND;
  }
  return { id: wallet.id, balanceCents: wallet.balanceCents, metadata };
}

/**
 * Resolve + authorize the (group, fund) pair: the caller must be allowed to
 * manage the GROUP's wallet, and the fund must belong to the group. Returns
 * the group's settlement-wallet id alongside the fund + its wallet.
 */
async function resolveFundTarget(
  currentUserId: string,
  groupId: string,
  fundId: string,
): Promise<{ groupWalletId: string; fund: FundResourceRow; fundWallet: WalletRow }> {
  const groupTarget = await resolveManagedWalletTarget(currentUserId, groupId);
  const fund = await getFundResource(groupId, fundId);
  const fundWallet = await getOrCreateFundWallet(fund.id, groupId);
  return { groupWalletId: groupTarget.walletId, fund, fundWallet };
}

/** Validates that `subgroupId` is a live child of `groupId` and returns it. */
async function resolveLiveSubgroup(
  groupId: string,
  subgroupId: string,
): Promise<{ id: string; name: string }> {
  const [subgroup] = await db
    .select({ id: agents.id, name: agents.name, parentId: agents.parentId, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, subgroupId))
    .limit(1);
  if (!subgroup || subgroup.deletedAt) throw new Error('Subgroup not found.');
  if (subgroup.parentId !== groupId) {
    throw new Error('That agent is not a subgroup of this group.');
  }
  return { id: subgroup.id, name: subgroup.name };
}

/** Case-insensitive name-uniqueness check among the group's NON-archived funds. */
async function assertFundNameAvailable(
  groupId: string,
  name: string,
  ignoreFundId?: string,
): Promise<void> {
  const funds = await listFundResources(groupId);
  const normalized = name.trim().toLowerCase();
  const clash = funds.find(
    (fund) =>
      fund.id !== ignoreFundId &&
      !readArchived(fund.metadata) &&
      fund.name.trim().toLowerCase() === normalized,
  );
  if (clash) {
    throw new Error(`A fund named "${name.trim()}" already exists in this treasury.`);
  }
}

/** Persist a fund resource's metadata (and optional name/description). */
async function updateFundResourceRow(
  fundId: string,
  changes: { name?: string; description?: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  await db
    .update(resources)
    .set({
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      metadata: changes.metadata,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, fundId));
}

// ---------------------------------------------------------------------------
// createFundAction
// ---------------------------------------------------------------------------

/**
 * Creates a named fund in the group's main treasury: a fund resource owned by
 * the group agent plus its bound (resource-keyed) wallet. Admin-gated via the
 * group's managed-wallet target.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {{ name: string; description?: string }} input - Fund name (unique among the group's non-archived funds) and optional description.
 * @returns {Promise<{ success: boolean; fundId?: string; error?: string }>} Operation outcome with the new fund's resource id.
 * @example
 * ```ts
 * const result = await createFundAction(groupId, { name: 'Land Fund' });
 * ```
 */
export async function createFundAction(
  groupId: string,
  input: { name: string; description?: string },
): Promise<{ success: boolean; fundId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  if (!isUuid(groupId)) {
    return { success: false, error: 'Invalid group.' };
  }
  const name = input?.name?.trim();
  if (!name) {
    return { success: false, error: 'A fund name is required.' };
  }
  if (name.length > FUND_NAME_MAX_LENGTH) {
    return { success: false, error: `Fund names are limited to ${FUND_NAME_MAX_LENGTH} characters.` };
  }
  const description = input.description?.trim() || null;

  const result = await updateFacade.execute(
    {
      type: 'createFundAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, name },
    },
    async () => {
      await resolveManagedWalletTarget(currentUserId, groupId);
      await assertFundNameAvailable(groupId, name);

      const [fund] = await db
        .insert(resources)
        .values({
          name,
          type: FUND_RESOURCE_TYPE,
          description,
          ownerId: groupId,
          visibility: 'members',
          metadata: {
            resourceKind: FUND_RESOURCE_KIND,
            groupId,
            assignedSubgroupIds: [],
            archived: false,
          },
        })
        .returning({ id: resources.id });

      await getOrCreateFundWallet(fund.id, groupId);

      return { success: true, fundId: fund.id } as {
        success: boolean;
        fundId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('createFundAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to create the fund.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: 'resource',
    entityId: result.data?.fundId ?? groupId,
    actorId: currentUserId,
    payload: { action: 'create_treasury_fund', groupId, name },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// updateFundAction
// ---------------------------------------------------------------------------

/**
 * Renames, re-describes, or (un)archives a fund. Archiving requires the fund
 * balance to be zero (move money back to the main treasury first — archiving
 * must never strand funds) and clears its subgroup assignments.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The fund resource UUID.
 * @param {{ name?: string; description?: string; archived?: boolean }} updates - Fields to change; at least one is required.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @example
 * ```ts
 * await updateFundAction(groupId, fundId, { name: 'Operations Fund' });
 * await updateFundAction(groupId, fundId, { archived: true });
 * ```
 */
export async function updateFundAction(
  groupId: string,
  fundId: string,
  updates: { name?: string; description?: string; archived?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  if (!isUuid(groupId) || !isUuid(fundId)) {
    return { success: false, error: 'Invalid fund.' };
  }

  const nextName = updates?.name?.trim();
  const hasName = nextName !== undefined && nextName !== '';
  if (updates?.name !== undefined && !hasName) {
    return { success: false, error: 'A fund name is required.' };
  }
  if (hasName && nextName.length > FUND_NAME_MAX_LENGTH) {
    return { success: false, error: `Fund names are limited to ${FUND_NAME_MAX_LENGTH} characters.` };
  }
  const hasDescription = updates?.description !== undefined;
  const hasArchived = typeof updates?.archived === 'boolean';
  if (!hasName && !hasDescription && !hasArchived) {
    return { success: false, error: 'Nothing to update.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'updateFundAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId, updates },
    },
    async () => {
      const { fund, fundWallet } = await resolveFundTarget(currentUserId, groupId, fundId);

      if (hasName) {
        await assertFundNameAvailable(groupId, nextName, fundId);
      }

      const metadata = { ...fund.metadata };
      if (hasArchived) {
        if (updates.archived === true) {
          if (fundWallet.balanceCents !== 0) {
            throw new Error(
              'Move the fund balance back to the main treasury before archiving it.',
            );
          }
          metadata.archived = true;
          // Archived funds release their subgroups back to unassigned.
          metadata.assignedSubgroupIds = [];
        } else {
          // Un-archiving must not silently collide with a live fund name
          // (a rename in the same call was already checked above).
          if (!hasName) {
            await assertFundNameAvailable(groupId, fund.name, fundId);
          }
          metadata.archived = false;
        }
      }

      await updateFundResourceRow(fundId, {
        ...(hasName ? { name: nextName } : {}),
        ...(hasDescription ? { description: updates.description?.trim() || null } : {}),
        metadata,
      });

      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('updateFundAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to update the fund.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: fundId,
    actorId: currentUserId,
    payload: { action: 'update_treasury_fund', groupId, fundId, updates },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// assignSubgroupToFundAction / unassignSubgroupFromFundAction
// ---------------------------------------------------------------------------

/**
 * Assigns a subgroup to a fund. A subgroup belongs to AT MOST one fund:
 * assigning it here removes it from any other fund of the same group first.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The destination fund resource UUID (must not be archived).
 * @param {string} subgroupId - A live child agent of the group (`agents.parentId`).
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @example
 * ```ts
 * await assignSubgroupToFundAction(groupId, fundId, subgroupId);
 * ```
 */
export async function assignSubgroupToFundAction(
  groupId: string,
  fundId: string,
  subgroupId: string,
): Promise<{ success: boolean; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  if (!isUuid(groupId) || !isUuid(fundId) || !isUuid(subgroupId)) {
    return { success: false, error: 'Invalid fund or subgroup.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'assignSubgroupToFundAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId, subgroupId },
    },
    async () => {
      const { fund } = await resolveFundTarget(currentUserId, groupId, fundId);
      if (readArchived(fund.metadata)) {
        throw new Error('Subgroups cannot be assigned to an archived fund.');
      }
      const subgroup = await resolveLiveSubgroup(groupId, subgroupId);

      // Single-fund invariant: strip the subgroup from every OTHER fund first.
      const funds = await listFundResources(groupId);
      for (const other of funds) {
        if (other.id === fund.id) continue;
        const assigned = readAssignedSubgroupIds(other.metadata);
        if (!assigned.includes(subgroup.id)) continue;
        await updateFundResourceRow(other.id, {
          metadata: {
            ...other.metadata,
            assignedSubgroupIds: assigned.filter((id) => id !== subgroup.id),
          },
        });
      }

      const assigned = readAssignedSubgroupIds(fund.metadata);
      if (!assigned.includes(subgroup.id)) {
        await updateFundResourceRow(fund.id, {
          metadata: {
            ...fund.metadata,
            assignedSubgroupIds: [...assigned, subgroup.id],
          },
        });
      }

      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('assignSubgroupToFundAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to assign the subgroup.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: fundId,
    actorId: currentUserId,
    payload: { action: 'assign_subgroup_to_fund', groupId, fundId, subgroupId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Removes a subgroup from a fund's assignment list.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The fund resource UUID.
 * @param {string} subgroupId - The subgroup agent UUID currently assigned to the fund.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @example
 * ```ts
 * await unassignSubgroupFromFundAction(groupId, fundId, subgroupId);
 * ```
 */
export async function unassignSubgroupFromFundAction(
  groupId: string,
  fundId: string,
  subgroupId: string,
): Promise<{ success: boolean; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  if (!isUuid(groupId) || !isUuid(fundId) || !isUuid(subgroupId)) {
    return { success: false, error: 'Invalid fund or subgroup.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'unassignSubgroupFromFundAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId, subgroupId },
    },
    async () => {
      const { fund } = await resolveFundTarget(currentUserId, groupId, fundId);
      const assigned = readAssignedSubgroupIds(fund.metadata);
      if (!assigned.includes(subgroupId)) {
        throw new Error('That subgroup is not assigned to this fund.');
      }

      await updateFundResourceRow(fund.id, {
        metadata: {
          ...fund.metadata,
          assignedSubgroupIds: assigned.filter((id) => id !== subgroupId),
        },
      });

      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('unassignSubgroupFromFundAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to unassign the subgroup.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: fundId,
    actorId: currentUserId,
    payload: { action: 'unassign_subgroup_from_fund', groupId, fundId, subgroupId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// transferFundBalanceAction
// ---------------------------------------------------------------------------

/**
 * Moves money between the group's main settlement wallet and a fund wallet as
 * an INTERNAL ledger transfer through {@link transferP2P} (wallet locks,
 * capital-entry consumption, ledger + transaction rows — no new money rails).
 * Inherits the platform transfer bounds (`MIN_TRANSFER_CENTS` /
 * `MAX_TRANSFER_CENTS` per transfer).
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The fund resource UUID.
 * @param {number} amountCents - Amount in cents (positive integer).
 * @param {FundTransferDirection} direction - `'to_fund'` moves main -> fund; `'to_main'` moves fund -> main.
 * @returns {Promise<{ success: boolean; transactionId?: string; error?: string }>} Operation outcome with the wallet transaction id.
 * @example
 * ```ts
 * await transferFundBalanceAction(groupId, fundId, 10_000, 'to_fund');
 * ```
 */
export async function transferFundBalanceAction(
  groupId: string,
  fundId: string,
  amountCents: number,
  direction: FundTransferDirection,
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  // Fund moves mutate wallet balances; reuse the shared wallet limiter bucket.
  const check = await rateLimit(
    `wallet:${currentUserId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(groupId) || !isUuid(fundId)) {
    return { success: false, error: 'Invalid fund.' };
  }
  if (direction !== 'to_fund' && direction !== 'to_main') {
    return { success: false, error: 'Invalid transfer direction.' };
  }
  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }
  if (amountCents < MIN_TRANSFER_CENTS) {
    return { success: false, error: `Minimum transfer is $${(MIN_TRANSFER_CENTS / 100).toFixed(2)}.` };
  }
  if (amountCents > MAX_TRANSFER_CENTS) {
    return { success: false, error: `Maximum transfer is $${(MAX_TRANSFER_CENTS / 100).toFixed(2)}.` };
  }

  const result = await updateFacade.execute(
    {
      type: 'transferFundBalanceAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId, amountCents, direction },
    },
    async () => {
      const { groupWalletId, fund, fundWallet } = await resolveFundTarget(
        currentUserId,
        groupId,
        fundId,
      );

      if (direction === 'to_fund' && readArchived(fund.metadata)) {
        throw new Error('Money cannot be moved into an archived fund.');
      }

      const [fromWalletId, toWalletId] =
        direction === 'to_fund'
          ? [groupWalletId, fundWallet.id]
          : [fundWallet.id, groupWalletId];

      const description =
        direction === 'to_fund'
          ? `Treasury allocation to fund: ${fund.name}`
          : `Fund return to main treasury: ${fund.name}`;

      const transaction = await transferP2P(fromWalletId, toWalletId, amountCents, description);

      return { success: true, transactionId: transaction.id } as {
        success: boolean;
        transactionId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('transferFundBalanceAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to move the funds.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: fundId,
    actorId: currentUserId,
    payload: { action: 'transfer_fund_balance', groupId, fundId, amountCents, direction },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// provisionFundFinancialAccountAction
// ---------------------------------------------------------------------------

/**
 * Provisions a Stripe Treasury FinancialAccount for a fund, hosted on the
 * GROUP's Custom Connect account (same host model as subgroup banking).
 * Idempotent: returns the existing FA id when one is already recorded on the
 * fund wallet. No-ops with an explanatory error while STRIPE_TREASURY_ENABLED
 * is off — Treasury is not yet granted on the platform.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The fund resource UUID.
 * @returns {Promise<{ success: boolean; financialAccountId?: string; error?: string }>} Operation outcome with the FA id.
 * @example
 * ```ts
 * await provisionFundFinancialAccountAction(groupId, fundId);
 * ```
 */
export async function provisionFundFinancialAccountAction(
  groupId: string,
  fundId: string,
): Promise<{ success: boolean; financialAccountId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled()) {
    return { success: false, error: 'Stripe Treasury is not enabled on this platform yet.' };
  }
  if (!isUuid(groupId) || !isUuid(fundId)) {
    return { success: false, error: 'Invalid fund.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'provisionFundFinancialAccountAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId },
    },
    async () => {
      const { groupWalletId, fund, fundWallet } = await resolveFundTarget(
        currentUserId,
        groupId,
        fundId,
      );
      if (readArchived(fund.metadata)) {
        throw new Error('Archived funds cannot be provisioned.');
      }

      const groupWallet = await getWalletRow(groupWalletId);
      const hostConnectAccountId = groupWallet.metadata.stripeConnectAccountId as
        | string
        | undefined;
      if (!hostConnectAccountId) {
        throw new Error('The group has no payment account yet. Set up group payments first.');
      }

      const existingFaId = fundWallet.metadata.stripeFinancialAccountId as string | undefined;
      if (existingFaId) {
        return { success: true, financialAccountId: existingFaId } as {
          success: boolean;
          financialAccountId?: string;
          error?: string;
        };
      }

      const financialAccount = await createTreasuryFinancialAccount({
        connectedAccountId: hostConnectAccountId,
        metadata: {
          walletId: fundWallet.id,
          ownerId: fund.id,
          parentGroupId: groupId,
          treasuryKind: FUND_TREASURY_KIND,
        },
      });

      await db
        .update(wallets)
        .set({
          metadata: {
            ...fundWallet.metadata,
            stripeFinancialAccountId: financialAccount.id,
            stripeHostConnectAccountId: hostConnectAccountId,
          },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, fundWallet.id));

      return { success: true, financialAccountId: financialAccount.id } as {
        success: boolean;
        financialAccountId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('provisionFundFinancialAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to provision the fund account.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: fundId,
    actorId: currentUserId,
    payload: {
      action: 'provision_fund_financial_account',
      groupId,
      fundId,
      financialAccountId: result.data?.financialAccountId,
    },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// issueFundCardAction
// ---------------------------------------------------------------------------

/**
 * Issues a virtual card to a fund, tethered to the fund's FinancialAccount
 * (the card can only spend that FA's balance). Creates the fund's company
 * cardholder on first use. The spending limit is mandatory — same platform
 * liability control as subgroup cards. No-ops with an explanatory error while
 * STRIPE_TREASURY_ENABLED / STRIPE_ISSUING_ENABLED are off.
 *
 * @param {string} groupId - The group agent UUID.
 * @param {string} fundId - The fund resource UUID.
 * @param {{ spendingLimitCents?: number; spendingLimitInterval?: 'daily' | 'weekly' | 'monthly' }} [options] - Spending limit override (defaults to $500/month).
 * @returns {Promise<{ success: boolean; cardId?: string; last4?: string; error?: string }>} Operation outcome with card id/last4.
 * @example
 * ```ts
 * await issueFundCardAction(groupId, fundId, { spendingLimitCents: 25_000 });
 * ```
 */
export async function issueFundCardAction(
  groupId: string,
  fundId: string,
  options?: { spendingLimitCents?: number; spendingLimitInterval?: 'daily' | 'weekly' | 'monthly' },
): Promise<{ success: boolean; cardId?: string; last4?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled() || !isIssuingEnabled()) {
    return { success: false, error: 'Card issuing is not enabled on this platform yet.' };
  }
  if (!isUuid(groupId) || !isUuid(fundId)) {
    return { success: false, error: 'Invalid fund.' };
  }

  const requestedLimit = options?.spendingLimitCents ?? DEFAULT_FUND_CARD_MONTHLY_LIMIT_CENTS;
  if (!isPositiveInteger(requestedLimit)) {
    return { success: false, error: 'The card spending limit must be a positive whole number of cents.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'issueFundCardAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, fundId, spendingLimitCents: requestedLimit },
    },
    async () => {
      const { fund, fundWallet } = await resolveFundTarget(currentUserId, groupId, fundId);

      const financialAccountId = fundWallet.metadata.stripeFinancialAccountId as
        | string
        | undefined;
      const hostConnectAccountId = fundWallet.metadata.stripeHostConnectAccountId as
        | string
        | undefined;
      if (!financialAccountId || !hostConnectAccountId) {
        throw new Error('Provision the fund account before issuing a card.');
      }

      let cardholderId = fundWallet.metadata.stripeIssuingCardholderId as string | undefined;
      if (!cardholderId) {
        const cardholder = await createIssuingCardholder({
          connectedAccountId: hostConnectAccountId,
          name: fund.name,
          metadata: { ownerId: fund.id, parentGroupId: groupId, treasuryKind: FUND_TREASURY_KIND },
        });
        cardholderId = cardholder.id;
        await db
          .update(wallets)
          .set({
            metadata: { ...fundWallet.metadata, stripeIssuingCardholderId: cardholderId },
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, fundWallet.id));
      }

      const card = await createTreasuryIssuingCard({
        connectedAccountId: hostConnectAccountId,
        cardholderId,
        financialAccountId,
        spendingLimitCents: requestedLimit,
        spendingLimitInterval: options?.spendingLimitInterval ?? 'monthly',
        metadata: { ownerId: fund.id, parentGroupId: groupId },
      });

      return { success: true, cardId: card.id, last4: card.last4 } as {
        success: boolean;
        cardId?: string;
        last4?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('issueFundCardAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to issue the card.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: fundId,
    actorId: currentUserId,
    payload: { action: 'issue_fund_card', groupId, fundId, cardId: result.data?.cardId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

// ---------------------------------------------------------------------------
// getGroupTreasuryFundsOverviewAction
// ---------------------------------------------------------------------------

/**
 * Aggregated funds view for the group Treasury tab: every fund with its
 * internal wallet balance, assigned subgroups, FA balance (degrades to null
 * when unbound or unreachable) and issued cards, plus each live subgroup's
 * current fund assignment for the assignment select. Admin-gated like the
 * banking overview.
 *
 * @param {string} groupId - The group agent UUID.
 * @returns {Promise<{ success: boolean; overview?: GroupTreasuryFundsOverview; error?: string }>} Overview payload or error.
 * @example
 * ```ts
 * const { overview } = await getGroupTreasuryFundsOverviewAction(groupId);
 * ```
 */
export async function getGroupTreasuryFundsOverviewAction(
  groupId: string,
): Promise<{ success: boolean; overview?: GroupTreasuryFundsOverview; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(groupId)) return { success: false, error: 'Invalid group.' };

  try {
    const groupTarget = await resolveManagedWalletTarget(currentUserId, groupId);
    const groupWallet = await getWalletRow(groupTarget.walletId);
    const groupConnectAccountId =
      (groupWallet.metadata.stripeConnectAccountId as string | undefined) ?? null;

    const [fundResources, children] = await Promise.all([
      listFundResources(groupId),
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.parentId, groupId), isNull(agents.deletedAt))),
    ]);

    const childNameById = new Map(children.map((child) => [child.id, child.name]));

    const funds = await Promise.all(
      fundResources.map(async (fund): Promise<TreasuryFundRow> => {
        const assignedSubgroups = readAssignedSubgroupIds(fund.metadata)
          .filter((id) => childNameById.has(id))
          .map((id) => ({ id, name: childNameById.get(id) as string }));
        const archived = readArchived(fund.metadata);

        try {
          const wallet = await getOrCreateFundWallet(fund.id, groupId);
          const faId = (wallet.metadata.stripeFinancialAccountId as string | undefined) ?? null;
          const host =
            (wallet.metadata.stripeHostConnectAccountId as string | undefined) ??
            groupConnectAccountId;
          const cardholderId =
            (wallet.metadata.stripeIssuingCardholderId as string | undefined) ?? null;

          const [faBalance, cards] = await Promise.all([
            faId && host
              ? getTreasuryFinancialAccountBalance(host, faId).catch(() => null)
              : Promise.resolve(null),
            cardholderId && host
              ? listIssuingCardsForCardholder(host, cardholderId).catch(() => [])
              : Promise.resolve([] as IssuedCardSummary[]),
          ]);

          return {
            fundId: fund.id,
            name: fund.name,
            description: fund.description,
            archived,
            balanceCents: wallet.balanceCents,
            assignedSubgroups,
            financialAccountId: faId,
            faCashCents: faBalance?.cash?.usd ?? null,
            cards,
          };
        } catch {
          return {
            fundId: fund.id,
            name: fund.name,
            description: fund.description,
            archived,
            balanceCents: 0,
            assignedSubgroups,
            financialAccountId: null,
            faCashCents: null,
            cards: [],
          };
        }
      }),
    );

    const fundIdBySubgroupId = new Map<string, string>();
    for (const fund of fundResources) {
      for (const subgroupId of readAssignedSubgroupIds(fund.metadata)) {
        fundIdBySubgroupId.set(subgroupId, fund.id);
      }
    }

    return {
      success: true,
      overview: {
        treasuryEnabled: isTreasuryEnabled(),
        issuingEnabled: isIssuingEnabled(),
        groupConnectAccountId,
        mainTreasuryBalanceCents: groupWallet.balanceCents,
        funds,
        subgroups: children.map((child) => ({
          id: child.id,
          name: child.name,
          assignedFundId: fundIdBySubgroupId.get(child.id) ?? null,
        })),
      },
    };
  } catch (error) {
    console.error('getGroupTreasuryFundsOverviewAction failed:', error);
    return { success: false, error: 'Unable to load the treasury funds overview.' };
  }
}
