'use server';

/**
 * Group ⇄ subgroup treasury apportionment (2026-07-14, backlog B13 cascade).
 *
 * The dormant subgroup-banking lane could provision a subgroup FinancialAccount
 * but there was no way to actually MOVE money from the parent group's treasury
 * into a subgroup's treasury — so the "group → subgroup → project → job payout"
 * cascade had a missing first hop. This mirrors {@link transferFundBalanceAction}
 * / {@link transferProjectBalanceAction}: an INTERNAL ledger transfer through
 * {@link transferP2P} between the parent group's main settlement wallet and a
 * subgroup's settlement wallet, gated on the PARENT group's treasury-management
 * authority (the account host + liability owner), exactly like subgroup banking.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { MIN_TRANSFER_CENTS, MAX_TRANSFER_CENTS } from '@/lib/wallet-constants';
import { getSettlementWalletForAgent, transferP2P } from '@/lib/wallet';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isUuid, isPositiveInteger } from './types';

/** `'to_subgroup'` funds the child from the parent; `'to_parent'` returns it. */
export type SubgroupFundingDirection = 'to_subgroup' | 'to_parent';

/**
 * Moves money between a group's main treasury and a subgroup's treasury as an
 * internal ledger transfer. Authority is the PARENT group's treasury-manage
 * authority ({@link resolveManagedWalletTarget}); the subgroup must be a live
 * child of the group (`agents.parentId`).
 *
 * @param {string} groupId - The parent group agent UUID (authority + funding source/sink).
 * @param {string} subgroupId - A live child agent of the group.
 * @param {number} amountCents - Amount in cents (positive integer within transfer bounds).
 * @param {SubgroupFundingDirection} direction - `'to_subgroup'` moves group -> subgroup; `'to_parent'` moves subgroup -> group.
 * @returns {Promise<{ success: boolean; transactionId?: string; error?: string }>} Outcome with the wallet transaction id.
 * @example
 * ```ts
 * await fundSubgroupBalanceAction(groupId, subgroupId, 25_000, 'to_subgroup');
 * ```
 */
export async function fundSubgroupBalanceAction(
  groupId: string,
  subgroupId: string,
  amountCents: number,
  direction: SubgroupFundingDirection,
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  const check = await rateLimit(
    `wallet:${currentUserId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(groupId) || !isUuid(subgroupId)) {
    return { success: false, error: 'Invalid group or subgroup.' };
  }
  if (groupId === subgroupId) {
    return { success: false, error: 'A group cannot fund itself.' };
  }
  if (direction !== 'to_subgroup' && direction !== 'to_parent') {
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
      type: 'fundSubgroupBalanceAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, subgroupId, amountCents, direction },
    },
    async () => {
      const parentTarget = await resolveManagedWalletTarget(currentUserId, groupId);

      const [subgroup] = await db
        .select({
          id: agents.id,
          name: agents.name,
          parentId: agents.parentId,
          deletedAt: agents.deletedAt,
        })
        .from(agents)
        .where(eq(agents.id, subgroupId))
        .limit(1);
      if (!subgroup || subgroup.deletedAt) throw new Error('Subgroup not found.');
      if (subgroup.parentId !== groupId) {
        throw new Error('That treasury is not a subgroup of this group.');
      }

      const subgroupWallet = await getSettlementWalletForAgent(subgroupId);

      const [fromWalletId, toWalletId] =
        direction === 'to_subgroup'
          ? [parentTarget.walletId, subgroupWallet.id]
          : [subgroupWallet.id, parentTarget.walletId];

      const description =
        direction === 'to_subgroup'
          ? `Treasury allocation to subgroup: ${subgroup.name}`
          : `Subgroup return to parent treasury: ${subgroup.name}`;

      const transaction = await transferP2P(fromWalletId, toWalletId, amountCents, description);

      return { success: true, transactionId: transaction.id } as {
        success: boolean;
        transactionId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('fundSubgroupBalanceAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to move the funds.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: subgroupId,
    actorId: currentUserId,
    payload: { action: 'fund_subgroup_balance', groupId, subgroupId, amountCents, direction },
  }).catch(() => {});

  return result.data ?? { success: true };
}
