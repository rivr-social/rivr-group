'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { ledger } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
  MIN_TRANSFER_CENTS,
  MAX_TRANSFER_CENTS,
} from '@/lib/wallet-constants';
import {
  getOrCreateWallet,
  createDepositIntent,
  transferP2P,
} from '@/lib/wallet';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId } from './helpers';
import { isUuid, isPositiveInteger } from './types';
import { releaseTestConnectBalanceToWalletInternal } from './seller';

/**
 * Creates a Stripe PaymentIntent for depositing funds into the user's personal wallet.
 *
 * @param {number} amountCents - Requested deposit amount in cents.
 * @returns {Promise<{ success: boolean; clientSecret?: string; error?: string }>} Stripe client secret on success, otherwise an error.
 * @throws {Error} Can throw if Stripe or DB dependencies fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await createDepositIntentAction(5000);
 * if (result.success) mountPaymentElement(result.clientSecret!);
 * ```
 */
export async function createDepositIntentAction(amountCents: number): Promise<{
  success: boolean;
  clientSecret?: string;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to deposit funds.' };
  }

  // Dedicated limiter bucket protects deposit intent creation from abuse.
  const check = await rateLimit(
    `wallet-deposit:${agentId}`,
    RATE_LIMITS.WALLET_DEPOSIT.limit,
    RATE_LIMITS.WALLET_DEPOSIT.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }

  if (amountCents < MIN_DEPOSIT_CENTS) {
    return { success: false, error: `Minimum deposit is $${(MIN_DEPOSIT_CENTS / 100).toFixed(2)}.` };
  }

  if (amountCents > MAX_DEPOSIT_CENTS) {
    return { success: false, error: `Maximum deposit is $${(MAX_DEPOSIT_CENTS / 100).toFixed(2)}.` };
  }

  try {
    const wallet = await getOrCreateWallet(agentId, 'personal');
    const result = await createDepositIntent(wallet.id, amountCents);
    return { success: true, clientSecret: result.clientSecret };
  } catch (error) {
    console.error('createDepositIntentAction failed:', error);
    return { success: false, error: 'Unable to create deposit. Please try again later.' };
  }
}

/**
 * Sends money from the current user's personal wallet to another agent's wallet.
 *
 * @param {string} recipientAgentId - Recipient agent UUID.
 * @param {number} amountCents - Transfer amount in cents.
 * @param {string} [message] - Optional transfer note stored with the transaction.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if transfer services fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await sendMoneyAction('11111111-1111-4111-8111-111111111111', 2500, 'Shared meal');
 * ```
 */
export async function sendMoneyAction(
  recipientAgentId: string,
  amountCents: number,
  message?: string
): Promise<{ success: boolean; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to send money.' };
  }

  // Shared wallet limiter constrains high-frequency transfer attempts.
  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(recipientAgentId)) {
    return { success: false, error: 'Invalid recipient.' };
  }

  if (recipientAgentId === agentId) {
    return { success: false, error: 'You cannot send money to yourself.' };
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
      type: 'sendMoneyAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { recipientAgentId, amountCents, message },
    },
    async () => {
      let senderWallet = await getOrCreateWallet(agentId, 'personal');
      if (senderWallet.balanceCents < amountCents) {
        const releaseResult = await releaseTestConnectBalanceToWalletInternal(agentId, agentId);
        if (releaseResult.success && (releaseResult.releasedCents ?? 0) > 0) {
          senderWallet = await getOrCreateWallet(agentId, 'personal');
        }
      }
      const recipientWallet = await getOrCreateWallet(recipientAgentId, 'personal');
      await transferP2P(senderWallet.id, recipientWallet.id, amountCents, message ?? 'P2P transfer');
      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('sendMoneyAction failed:', result.error);
    return { success: false, error: result.error ?? 'Transfer failed' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: agentId,
    actorId: agentId,
    payload: { recipientAgentId, amountCents, message },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Deposits funds from the current user's personal wallet into a group wallet.
 *
 * @param {string} groupId - Group UUID.
 * @param {number} amountCents - Deposit amount in cents.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if membership checks or wallet transfers fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await depositToGroupWalletAction(groupId, 5000);
 * ```
 */
export async function depositToGroupWalletAction(
  groupId: string,
  amountCents: number
): Promise<{ success: boolean; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to deposit to a group wallet.' };
  }

  // Group wallet funding is rate-limited because it mutates wallet balances.
  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(groupId)) {
    return { success: false, error: 'Invalid group.' };
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
      type: 'depositToGroupWalletAction',
      actorId: agentId,
      targetAgentId: groupId,
      payload: { groupId, amountCents },
    },
    async () => {
      // Security check: only active members can move funds into the group wallet.
      const membership = await db.query.ledger.findFirst({
        where: and(
          eq(ledger.subjectId, agentId),
          eq(ledger.objectId, groupId),
          eq(ledger.isActive, true)
        ),
        columns: { id: true, verb: true },
      });

      if (!membership || (membership.verb !== 'join' && membership.verb !== 'belong')) {
        throw new Error('You must be a member of this group to deposit.');
      }

      const personalWallet = await getOrCreateWallet(agentId, 'personal');
      const groupWallet = await getOrCreateWallet(groupId, 'group');
      await transferP2P(personalWallet.id, groupWallet.id, amountCents, 'Group deposit');
      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('depositToGroupWalletAction failed:', result.error);
    return { success: false, error: result.error ?? 'Group deposit failed' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: groupId,
    actorId: agentId,
    payload: { groupId, amountCents },
  }).catch(() => {});

  return result.data ?? { success: true };
}
