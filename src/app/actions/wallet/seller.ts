'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { wallets, walletTransactions } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getConnectBalance,
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
  createPayout,
  createLoginLink,
} from '@/lib/stripe-connect';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isPositiveInteger } from './types';

export async function releaseTestConnectBalanceToWalletInternal(
  currentUserId: string,
  ownerId?: string,
): Promise<{ success: boolean; releasedCents?: number; error?: string }> {
  const stripeSecret = process.env.STRIPE_SECRET_KEY ?? '';
  if (!stripeSecret.startsWith('sk_test_')) {
    return { success: false, error: 'This action is only available in Stripe test mode.' };
  }

  try {
    const target = await resolveManagedWalletTarget(currentUserId, ownerId);
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, target.walletId))
      .limit(1);

    if (!wallet) {
      return { success: false, error: 'Treasury wallet not found.' };
    }

    const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;
    if (!connectAccountId) {
      return { success: false, error: 'No Stripe Connect account found.' };
    }

    const connectBalance = await getConnectBalance(connectAccountId);
    const totalTestSalesCents = connectBalance.availableCents + connectBalance.pendingCents;
    const previouslyReleasedCents =
      typeof walletMeta.testConnectReleasedCents === 'number' ? walletMeta.testConnectReleasedCents : 0;
    const releasableCents = Math.max(0, totalTestSalesCents - previouslyReleasedCents);

    if (releasableCents <= 0) {
      return { success: true, releasedCents: 0 };
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`);

      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${releasableCents}`,
          metadata: {
            ...walletMeta,
            testConnectReleasedCents: previouslyReleasedCents + releasableCents,
            lastTestConnectReleaseAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));

      await tx.insert(walletTransactions).values({
        type: 'marketplace_payout',
        toWalletId: wallet.id,
        amountCents: releasableCents,
        feeCents: 0,
        currency: 'usd',
        description: 'Released Stripe test sales balance to Rivr wallet',
        status: 'completed',
        metadata: {
          source: 'stripe_test_release',
          connectAccountId,
          ownerId: target.ownerId,
          availableCents: connectBalance.availableCents,
          pendingCents: connectBalance.pendingCents,
        },
      });
    });

    return { success: true, releasedCents: releasableCents };
  } catch (error) {
    console.error('releaseTestConnectBalanceToWalletInternal failed:', error);
    return { success: false, error: 'Unable to release Stripe test sales to wallet.' };
  }
}

/**
 * Sets up a Stripe Connect Express account for the current user and returns the onboarding URL.
 *
 * @returns {Promise<{ success: boolean; url?: string; error?: string }>} Onboarding URL on success.
 * @throws {Error} Can throw if Stripe or DB dependencies fail unexpectedly.
 * @example
 * ```ts
 * const result = await setupConnectAccountAction();
 * if (result.success) window.location.assign(result.url!);
 * ```
 */
export async function setupConnectAccountAction(
  ownerId?: string,
  returnPath?: string
): Promise<{
  success: boolean;
  url?: string;
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in to set up payments.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'setupConnectAccountAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { ownerId, returnPath },
    },
    async () => {
      const target = await resolveManagedWalletTarget(currentUserId, ownerId);
      const [wallet] = await db
        .select({ id: wallets.id, metadata: wallets.metadata })
        .from(wallets)
        .where(eq(wallets.id, target.walletId))
        .limit(1);

      if (!wallet) {
        throw new Error('Treasury wallet not found.');
      }

      const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;

      let connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;

      if (!connectAccountId) {
        const account = await createConnectAccount(target.ownerId, target.email ?? undefined, {
          walletId: wallet.id,
          ownerId: target.ownerId,
          walletType: target.walletType,
          returnPath: ownerId ? `/groups/${ownerId}?tab=treasury` : '/settings',
        });
        connectAccountId = account.id;

        await db
          .update(wallets)
          .set({
            metadata: { ...walletMeta, stripeConnectAccountId: connectAccountId },
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, wallet.id));
      }

      const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
      const targetPath = returnPath || (ownerId ? `/groups/${ownerId}?tab=treasury` : '/settings');
      const url = await createAccountLink(
        connectAccountId,
        `${baseUrl}/api/stripe/connect?account_id=${connectAccountId}&owner_id=${target.ownerId}&return_path=${encodeURIComponent(targetPath)}`,
        `${baseUrl}/api/stripe/connect?account_id=${connectAccountId}&owner_id=${target.ownerId}&return_path=${encodeURIComponent(targetPath)}`
      );

      return { success: true, url } as { success: boolean; url?: string; error?: string };
    },
  );

  if (!result.success) {
    console.error('setupConnectAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to set up payment account. Please try again.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { action: 'setup_connect', ownerId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Returns the current user's Connect account onboarding/active status.
 *
 * @returns {Promise<{ success: boolean; status?: { hasAccount: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean; dashboardUrl?: string }; error?: string }>}
 */
export async function getConnectStatusAction(ownerId?: string): Promise<{
  success: boolean;
  status?: {
    hasAccount: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    dashboardUrl?: string;
  };
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }

  try {
    const target = await resolveManagedWalletTarget(currentUserId, ownerId);
    const [wallet] = await db
      .select({ id: wallets.id, metadata: wallets.metadata })
      .from(wallets)
      .where(eq(wallets.id, target.walletId))
      .limit(1);

    if (!wallet) {
      return { success: false, error: 'Treasury wallet not found.' };
    }

    const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;

    if (!connectAccountId) {
      return {
        success: true,
        status: {
          hasAccount: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
        },
      };
    }

    const accountStatus = await getAccountStatus(connectAccountId);
    let dashboardUrl: string | undefined;

    if (accountStatus.chargesEnabled) {
      try {
        dashboardUrl = await createLoginLink(connectAccountId);
      } catch {
        // Login link may fail if account isn't fully active yet
      }
    }

    return {
      success: true,
      status: {
        hasAccount: true,
        ...accountStatus,
        dashboardUrl,
      },
    };
  } catch (error) {
    console.error('getConnectStatusAction failed:', error);
    return { success: false, error: 'Unable to retrieve account status.' };
  }
}

/**
 * Returns the current user's Connect balance (available + pending).
 *
 * @returns {Promise<{ success: boolean; balance?: { availableCents: number; pendingCents: number }; error?: string }>}
 */
export async function getConnectBalanceAction(ownerId?: string): Promise<{
  success: boolean;
  balance?: { availableCents: number; pendingCents: number };
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }

  try {
    const target = await resolveManagedWalletTarget(currentUserId, ownerId);
    const [wallet] = await db
      .select({ id: wallets.id, metadata: wallets.metadata })
      .from(wallets)
      .where(eq(wallets.id, target.walletId))
      .limit(1);

    if (!wallet) {
      return { success: false, error: 'Treasury wallet not found.' };
    }

    const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;

    if (!connectAccountId) {
      return { success: true, balance: { availableCents: 0, pendingCents: 0 } };
    }

    const balance = await getConnectBalance(connectAccountId);
    return { success: true, balance };
  } catch (error) {
    console.error('getConnectBalanceAction failed:', error);
    return { success: false, error: 'Unable to retrieve sales balance.' };
  }
}

export async function releaseTestConnectBalanceToWalletAction(ownerId?: string): Promise<{
  success: boolean;
  releasedCents?: number;
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'releaseTestConnectBalanceToWalletAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { ownerId },
    },
    async () => {
      return releaseTestConnectBalanceToWalletInternal(currentUserId, ownerId);
    },
  );

  if (!result.success) {
    return { success: false, error: result.error ?? 'Unable to release Stripe test sales to wallet.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { action: 'release_test_balance', ownerId, releasedCents: result.data?.releasedCents },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Initiates a payout from the user's Connect account to their linked bank account.
 *
 * @param {number} amountCents - Payout amount in cents.
 * @param {'standard' | 'instant'} speed - Payout speed.
 * @returns {Promise<{ success: boolean; payoutId?: string; error?: string }>}
 */
export async function requestPayoutAction(
  amountCents: number,
  speed: 'standard' | 'instant' = 'standard',
  ownerId?: string
): Promise<{ success: boolean; payoutId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }

  const check = await rateLimit(
    `wallet:${currentUserId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'requestPayoutAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { amountCents, speed, ownerId },
    },
    async () => {
      const target = await resolveManagedWalletTarget(currentUserId, ownerId);
      const [wallet] = await db
        .select({ id: wallets.id, metadata: wallets.metadata })
        .from(wallets)
        .where(eq(wallets.id, target.walletId))
        .limit(1);

      if (!wallet) {
        throw new Error('Treasury wallet not found.');
      }

      const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
      const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;

      if (!connectAccountId) {
        throw new Error('No payment account found. Set up payments first.');
      }

      // Verify sufficient balance
      const balance = await getConnectBalance(connectAccountId);
      if (balance.availableCents < amountCents) {
        throw new Error('Insufficient available balance for payout.');
      }

      const payout = await createPayout(connectAccountId, amountCents, speed);

      // Record the payout in wallet transactions for audit
      await db.insert(walletTransactions).values({
        type: 'connect_payout',
        fromWalletId: wallet.id,
        amountCents,
        feeCents: 0,
        currency: 'usd',
        description: `Payout to bank (${speed})`,
        status: 'pending',
        metadata: {
          stripePayoutId: payout.id,
          connectAccountId,
          speed,
          ownerId: target.ownerId,
        },
      });

      return { success: true, payoutId: payout.id } as { success: boolean; payoutId?: string; error?: string };
    },
  );

  if (!result.success) {
    console.error('requestPayoutAction failed:', result.error);
    return { success: false, error: result.error ?? 'Payout failed' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { amountCents, speed, payoutId: result.data?.payoutId },
  }).catch(() => {});

  return result.data ?? { success: true };
}
