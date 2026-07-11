'use server';

/**
 * Treasury ⇄ project-wallet apportionment (2026-07-11).
 *
 * Before this action existed a project wallet could only fill from Stripe
 * revenue splits on project-bound offerings, so `recordProjectExpenseAction`
 * ("Fund the project before recording expenses") was unreachable for projects
 * without sales — the 2026-07-11 persona simulation rated treasury→project
 * apportionment 1/5 because no front-end path existed at all. This mirrors
 * `transferFundBalanceAction`: an INTERNAL ledger transfer through
 * {@link transferP2P} between the group's main settlement wallet and a
 * project's resource-bound wallet, in either direction, gated on treasury
 * management authority.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { resources } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  MIN_TRANSFER_CENTS,
  MAX_TRANSFER_CENTS,
} from '@/lib/wallet-constants';
import { getOrCreateProjectWallet, transferP2P } from '@/lib/wallet';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isUuid, isPositiveInteger } from './types';

export type ProjectFundingDirection = 'to_project' | 'to_main';

const PROJECT_STATUS_COMPLETED = 'completed';

/**
 * Moves money between the group's main treasury and a project's wallet as an
 * internal ledger transfer. `'to_project'` funds the project from the
 * treasury; `'to_main'` returns unspent project balance to the treasury.
 * Authority mirrors every other treasury move: the caller must be able to
 * manage the group's wallet ({@link resolveManagedWalletTarget}). Completed
 * projects refuse new funding — their residue belongs to the completion
 * sweep, not to fresh allocations.
 *
 * @param {string} groupId - The owning group agent UUID.
 * @param {string} projectId - The `resources.id` of the `project` resource.
 * @param {number} amountCents - Amount in cents (positive integer).
 * @param {ProjectFundingDirection} direction - `'to_project'` moves main -> project; `'to_main'` moves project -> main.
 * @returns {Promise<{ success: boolean; transactionId?: string; error?: string }>} Operation outcome with the wallet transaction id.
 * @example
 * ```ts
 * await transferProjectBalanceAction(groupId, projectId, 5_000, 'to_project');
 * ```
 */
export async function transferProjectBalanceAction(
  groupId: string,
  projectId: string,
  amountCents: number,
  direction: ProjectFundingDirection,
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  // Project funding mutates wallet balances; reuse the shared wallet limiter bucket.
  const check = await rateLimit(
    `wallet:${currentUserId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(groupId) || !isUuid(projectId)) {
    return { success: false, error: 'Invalid project.' };
  }
  if (direction !== 'to_project' && direction !== 'to_main') {
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
      type: 'transferProjectBalanceAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, projectId, amountCents, direction },
    },
    async () => {
      const groupTarget = await resolveManagedWalletTarget(currentUserId, groupId);

      const [project] = await db
        .select({
          id: resources.id,
          name: resources.name,
          type: resources.type,
          ownerId: resources.ownerId,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(and(eq(resources.id, projectId), isNull(resources.deletedAt)))
        .limit(1);
      if (!project || project.type !== 'project') {
        throw new Error('Project not found.');
      }
      if (project.ownerId !== groupId) {
        throw new Error('That project does not belong to this group.');
      }

      const projectMeta = (project.metadata ?? {}) as Record<string, unknown>;
      if (direction === 'to_project' && projectMeta.status === PROJECT_STATUS_COMPLETED) {
        throw new Error('Money cannot be moved into a completed project.');
      }

      const projectWallet = await getOrCreateProjectWallet(project.id, groupId);

      const [fromWalletId, toWalletId] =
        direction === 'to_project'
          ? [groupTarget.walletId, projectWallet.id]
          : [projectWallet.id, groupTarget.walletId];

      const description =
        direction === 'to_project'
          ? `Treasury allocation to project: ${project.name}`
          : `Project return to main treasury: ${project.name}`;

      const transaction = await transferP2P(fromWalletId, toWalletId, amountCents, description);

      return { success: true, transactionId: transaction.id } as {
        success: boolean;
        transactionId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('transferProjectBalanceAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to move the funds.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: projectId,
    actorId: currentUserId,
    payload: { action: 'transfer_project_balance', groupId, projectId, amountCents, direction },
  }).catch(() => {});

  return result.data ?? { success: true };
}
