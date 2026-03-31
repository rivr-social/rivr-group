'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { resources, wallets } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { isValidEthAddress } from '@/lib/eth-utils';
import {
  getOrCreateWallet,
  setEthAddress,
  recordEthPayment,
} from '@/lib/wallet';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId } from './helpers';
import { isUuid, isPositiveInteger, ETH_TX_HASH_RE } from './types';

/**
 * Sets or updates the Ethereum address for the current user's personal wallet.
 *
 * @param {string} ethAddress - Wallet ETH address to store.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if wallet persistence fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await setEthAddressAction('0x1234567890abcdef1234567890abcdef12345678');
 * ```
 */
export async function setEthAddressAction(ethAddress: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to set your ETH address.' };
  }

  const isClear = !ethAddress || ethAddress.trim() === '';

  if (!isClear && !isValidEthAddress(ethAddress)) {
    return { success: false, error: 'Invalid Ethereum address format.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'setEthAddressAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { ethAddress },
    },
    async () => {
      const wallet = await getOrCreateWallet(agentId, 'personal');
      if (isClear) {
        await db
          .update(wallets)
          .set({ ethAddress: null, updatedAt: new Date() })
          .where(eq(wallets.id, wallet.id));
      } else {
        await setEthAddress(wallet.id, ethAddress);
      }
      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('setEthAddressAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to set ETH address. Please try again later.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_DEPOSIT,
    entityType: 'wallet',
    entityId: agentId,
    actorId: agentId,
    payload: { action: 'set_eth_address', ethAddress: isClear ? null : ethAddress },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Records an off-chain Ethereum payment between two agents.
 *
 * @param {string} recipientAgentId - Recipient agent UUID.
 * @param {number} amountCents - Amount in cents for normalized accounting.
 * @param {string} ethTxHash - Ethereum transaction hash (`0x` + 64 hex chars).
 * @param {string} description - Required description for auditability.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if wallet-record persistence fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await recordEthPaymentAction(recipientId, 2000, txHash, 'Reimbursement');
 * ```
 */
export async function recordEthPaymentAction(
  recipientAgentId: string,
  amountCents: number,
  ethTxHash: string,
  description: string,
  listingId?: string,
  platformFeeTxHash?: string
): Promise<{ success: boolean; receiptId?: string; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to record an ETH payment.' };
  }

  // Rate limiting protects the audit log path from spam and brute-force submissions.
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

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }

  if (!ETH_TX_HASH_RE.test(ethTxHash)) {
    return { success: false, error: 'Invalid Ethereum transaction hash format (expected 0x + 64 hex characters).' };
  }

  if (!description.trim()) {
    return { success: false, error: 'Description is required for ETH payment records.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'recordEthPaymentAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { recipientAgentId, amountCents, ethTxHash, description, listingId, platformFeeTxHash },
    },
    async () => {
      const senderWallet = await getOrCreateWallet(agentId, 'personal');
      const recipientWallet = await getOrCreateWallet(recipientAgentId, 'personal');
      await recordEthPayment(
        senderWallet.id,
        recipientWallet.id,
        amountCents,
        ethTxHash,
        description.trim()
      );

      // Create receipt resource for buyer's purchase history
      if (listingId) {
        const receiptId = crypto.randomUUID();
        await db.insert(resources).values({
          id: receiptId,
          name: `Receipt: ${listingId}`,
          type: 'receipt',
          ownerId: agentId,
          description: `Purchase receipt for listing ${listingId}`,
          metadata: {
            originalListingId: listingId,
            buyerAgentId: agentId,
            sellerAgentId: recipientAgentId,
            amount: amountCents,
            priceCents: amountCents,
            totalCents: amountCents,
            currency: 'crypto',
            txHash: ethTxHash,
            platformFeeTxHash: platformFeeTxHash ?? null,
            purchasedAt: new Date().toISOString(),
            status: 'completed',
            paymentMethod: 'crypto',
          },
        });
        return { success: true, receiptId } as { success: boolean; receiptId?: string; error?: string };
      }

      return { success: true } as { success: boolean; receiptId?: string; error?: string };
    },
  );

  if (!result.success) {
    console.error('recordEthPaymentAction failed:', result.error);
    return { success: false, error: result.error ?? 'Failed to record ETH payment' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_DEPOSIT,
    entityType: 'wallet',
    entityId: agentId,
    actorId: agentId,
    payload: { recipientAgentId, amountCents, ethTxHash },
  }).catch(() => {});

  return result.data ?? { success: true };
}
