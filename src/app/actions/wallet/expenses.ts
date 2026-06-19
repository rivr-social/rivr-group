'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { resources } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  MIN_TRANSFER_CENTS,
  MAX_TRANSFER_CENTS,
} from '@/lib/wallet-constants';
import {
  getProjectWalletForResource,
  recordProjectExpense,
} from '@/lib/wallet';
import { canModifyResource } from '@/app/actions/resource-creation/helpers';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId } from './helpers';
import { isUuid, isPositiveInteger } from './types';

const RESOURCE_TYPE_PROJECT = 'project';

/**
 * Records a first-class expense (debit) out of a project's treasury wallet to an
 * external payee. The caller must control the project resource (owner or a
 * write-capable member of the owning group/org), enforced via
 * {@link canModifyResource}.
 *
 * @param {string} projectId - The `resources.id` of the `project` resource.
 * @param {number} amountCents - Expense amount in cents.
 * @param {{ description: string; category?: string; payee?: string }} input - Expense detail.
 * @returns {Promise<{ success: boolean; transactionId?: string; error?: string }>} Operation outcome.
 * @example
 * ```ts
 * await recordProjectExpenseAction(projectId, 12500, { description: 'Lumber', payee: 'Ace Hardware' });
 * ```
 */
export async function recordProjectExpenseAction(
  projectId: string,
  amountCents: number,
  input: { description: string; category?: string; payee?: string }
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to record an expense.' };
  }

  // Expenses mutate treasury balances; reuse the shared wallet limiter bucket.
  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(projectId)) {
    return { success: false, error: 'Invalid project.' };
  }

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }

  if (amountCents < MIN_TRANSFER_CENTS) {
    return { success: false, error: `Minimum expense is $${(MIN_TRANSFER_CENTS / 100).toFixed(2)}.` };
  }

  if (amountCents > MAX_TRANSFER_CENTS) {
    return { success: false, error: `Maximum expense is $${(MAX_TRANSFER_CENTS / 100).toFixed(2)}.` };
  }

  const description = input?.description?.trim();
  if (!description) {
    return { success: false, error: 'A description is required for the expense.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'recordProjectExpenseAction',
      actorId: agentId,
      targetAgentId: projectId,
      payload: { projectId, amountCents, description },
    },
    async () => {
      const access = await canModifyResource(agentId, projectId);
      if (!access.allowed || !access.resource) {
        throw new Error('You do not have permission to spend from this project treasury.');
      }

      // The `resources.type` column is authoritative for the project guard.
      const isProject = await resolveResourceTypeIsProject(projectId);
      if (!isProject) {
        throw new Error('Expenses can only be recorded against a project.');
      }

      const projectWallet = await getProjectWalletForResource(projectId);
      if (!projectWallet) {
        throw new Error('This project has no treasury wallet yet. Fund the project before recording expenses.');
      }

      const transaction = await recordProjectExpense(projectWallet.id, amountCents, {
        description,
        category: input.category?.trim() || undefined,
        payee: input.payee?.trim() || undefined,
      });

      return { success: true, transactionId: transaction.id } as {
        success: boolean;
        transactionId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('recordProjectExpenseAction failed:', result.error);
    return { success: false, error: result.error ?? 'Failed to record expense.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: projectId,
    actorId: agentId,
    payload: { projectId, amountCents, description, expense: true },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Confirms a resource row is of type `project`. Used as a defensive guard before
 * debiting a treasury when the in-memory metadata does not carry the type.
 */
async function resolveResourceTypeIsProject(resourceId: string): Promise<boolean> {
  const [row] = await db
    .select({ type: resources.type })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);
  return row?.type === RESOURCE_TYPE_PROJECT;
}
