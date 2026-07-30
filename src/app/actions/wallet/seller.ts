'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { wallets, walletTransactions } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getConnectBalance,
  getAccountStatus,
  createLoginLink,
} from '@/lib/stripe-connect';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { settleConnectPayout } from '@/lib/connect-payout';
import { assertNoRecoveryDebt } from '@/lib/payout-debt-guard';
import {
  isGlobalConnectOnboardingEnabled,
  requestGlobalConnectOnboarding,
} from '@/lib/global-connect-onboarding';
import {
  consumeWalletCapital,
  restoreWalletCapitalFromConsumptions,
} from '@/lib/wallet';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isPositiveInteger } from './types';
import {
  createFinancialConnectionsSession,
  createTreasuryFinancialAccount,
  getExternalBankBalance,
  getTreasuryFinancialAccountBalance,
  isFinancialConnectionsEnabled,
  isTreasuryEnabled,
  retrieveFinancialConnectionsAccount,
} from '@/lib/stripe-treasury';

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
 * Legacy local onboarding entry point. Global owns account creation and
 * onboarding, so Group authenticates/routs the request and fails closed locally.
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
  returnPath?: string,
  accountCountry?: string,
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
      payload: { ownerId, returnPath, accountCountry },
    },
    async () => {
      // Global holds every connected account, so onboarding is requested from
      // it rather than created here. The seller returns to THIS instance.
      //
      // Check the lane FIRST: complaining about this instance's base-URL
      // configuration for a feature that is switched off is a misleading error.
      if (!isGlobalConnectOnboardingEnabled()) {
        throw new Error('Payment onboarding is not enabled yet.');
      }
      const instanceBaseUrl = (
        process.env.NEXT_PUBLIC_BASE_URL ??
        process.env.BASE_URL ??
        process.env.NEXTAUTH_URL ??
        ''
      ).replace(/\/+$/, '');
      if (!instanceBaseUrl) {
        throw new Error('This instance has no configured base URL for the onboarding return.');
      }
      const safeReturnPath =
        returnPath && returnPath.startsWith('/') ? returnPath : '/settings';

      const onboarding = await requestGlobalConnectOnboarding({
        sellerAgentId: ownerId ?? currentUserId,
        // Immutable on the Stripe account, so it must be an explicit choice.
        accountCountry: accountCountry ?? '',
        returnUrl: `${instanceBaseUrl}${safeReturnPath}`,
        refreshUrl: `${instanceBaseUrl}${safeReturnPath}`,
      });

      switch (onboarding.status) {
        case 'ok':
          return { success: true, url: onboarding.url };
        case 'disabled':
          throw new Error('Payment onboarding is not enabled yet.');
        case 'invalid':
          throw new Error(
            onboarding.detail ?? 'Choose your bank country before setting up payouts.',
          );
        case 'not-authorized':
          console.error('[connect-onboarding] Global rejected:', onboarding.detail);
          throw new Error('Payment onboarding is not available for this account.');
        default:
          console.error('[connect-onboarding] failed:', onboarding.detail);
          throw new Error('Unable to start payment onboarding. Please try again.');
      }
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
/**
 * "Move to Stripe" — resolve internal Rivr wallet credit into REAL money in the
 * owner's Stripe Connect balance, from which {@link requestPayoutAction} pays out
 * to their bank. The Rivr wallet is a platform IOU (instant, fee-free internal
 * credit); converting it to real funds means real dollars move to the payee's
 * connected account. On a sovereign instance the transfer is fulfilled by GLOBAL
 * (the single Connect authority) via {@link settleConnectPayout}, which resolves
 * the payee's global-held account and does the Stripe Transfer there.
 *
 * Saga: debit the wallet + write a `pending` ledger row in one locked tx, request
 * the federated transfer keyed on that row's id (retry-safe), then mark it
 * `completed`. Definitive rejections compensate the wallet; ambiguous transport
 * outcomes remain reserved as `submission_unknown` for reconciliation.
 */
export async function resolveWalletToConnectAction(
  amountCents: number,
  ownerId?: string,
): Promise<{ success: boolean; transferId?: string; newBalanceCents?: number; error?: string }> {
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
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'resolveWalletToConnectAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { amountCents, ownerId },
    },
    async () => {
      const target = await resolveManagedWalletTarget(currentUserId, ownerId);
      const [wallet] = await db
        .select({ id: wallets.id, balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, target.walletId))
        .limit(1);
      if (!wallet) throw new Error('Wallet not found.');

      // A negative balance is recovery debt from a refund or chargeback. Report
      // it honestly rather than as "insufficient balance" — the seller needs to
      // know WHY cash-out is blocked and that it resumes on its own once sales
      // net the deficit back to zero. Kept in lockstep with global + person.
      assertNoRecoveryDebt(wallet.balanceCents);
      if (wallet.balanceCents < amountCents) {
        throw new Error('Insufficient Rivr wallet balance.');
      }

      // 1) Debit the wallet + pending ledger row in ONE locked tx.
      const pendingPayout = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`);
        const [locked] = await tx
          .select({ balanceCents: wallets.balanceCents })
          .from(wallets)
          .where(eq(wallets.id, wallet.id))
          .limit(1);
        if (!locked || locked.balanceCents < amountCents) {
          throw new Error('Insufficient Rivr wallet balance.');
        }
        const capitalConsumptions = await consumeWalletCapital(
          tx,
          wallet.id,
          locked.balanceCents,
          amountCents,
          { clearedOnly: true },
        );
        await tx
          .update(wallets)
          .set({ balanceCents: sql`${wallets.balanceCents} - ${amountCents}`, updatedAt: new Date() })
          .where(eq(wallets.id, wallet.id));
        const [row] = await tx
          .insert(walletTransactions)
          .values({
            type: 'connect_payout',
            fromWalletId: wallet.id,
            amountCents,
            feeCents: 0,
            currency: 'usd',
            description: 'Submitted payout obligation to Global',
            status: 'pending',
            metadata: {
              source: 'global_payout_obligation',
              ownerId: target.ownerId,
              corridor: 'auto',
            },
          })
          .returning({ id: walletTransactions.id });
        return { txnId: row.id, capitalConsumptions };
      });
      const { txnId, capitalConsumptions } = pendingPayout;

      // 2) Submit the authenticated obligation to GLOBAL. GLOBAL owns recipient
      // verification and chooses Connect versus Global Payouts by country.
      const settle = await settleConnectPayout({
        payeeAgentId: target.ownerId,
        amountCents,
        idempotencyKey: `wallet-cashout:${txnId}`,
        metadata: {
          walletTransactionId: txnId,
          source: 'global_payout_obligation',
          corridor: 'auto',
        },
      });

      if (settle.status !== 'paid') {
        const definitivelyRejected =
          settle.status === 'disabled' ||
          settle.status === 'needs_onboarding' ||
          settle.status === 'insufficient_funds';
        if (definitivelyRejected) {
          await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`);
            await tx
              .update(wallets)
              .set({
                balanceCents: sql`${wallets.balanceCents} + ${amountCents}`,
                updatedAt: new Date(),
              })
              .where(eq(wallets.id, wallet.id));
            await restoreWalletCapitalFromConsumptions(
              tx,
              wallet.id,
              capitalConsumptions,
              {
                sourceType: 'global_payout_compensation',
                sourceTransactionId: txnId,
                metadata: { settleStatus: settle.status },
              },
            );
            await tx
              .update(walletTransactions)
              .set({
                status: 'failed',
                metadata: {
                  source: 'global_payout_obligation',
                  ownerId: target.ownerId,
                  settleStatus: settle.status,
                  detail: settle.detail,
                  compensated: true,
                },
              })
              .where(eq(walletTransactions.id, txnId));
          });
        } else {
          // A transport/server error can mean Global accepted the idempotent
          // request but Group missed the response. Preserve the debit and capital
          // consumption for reconciliation; compensating here could double-pay.
          await db
            .update(walletTransactions)
            .set({
              status: 'submission_unknown',
              metadata: {
                source: 'global_payout_obligation',
                ownerId: target.ownerId,
                settleStatus: settle.status,
                detail: settle.detail,
                compensated: false,
              },
            })
            .where(eq(walletTransactions.id, txnId));
        }
        const message =
          settle.status === 'needs_onboarding'
            ? 'Finish payment onboarding before moving funds to Stripe.'
            : settle.status === 'insufficient_funds'
              ? 'The platform cannot back this transfer right now — try a smaller amount or try again later.'
              : settle.status === 'disabled'
                ? 'Global payouts are not enabled.'
                : 'Payout submission is awaiting reconciliation. Funds remain reserved and were not returned.';
        throw new Error(message);
      }

      // 3b) Confirm.
      await db
        .update(walletTransactions)
        .set({
          status: 'completed',
          metadata: {
            source: 'global_payout_obligation',
            ownerId: target.ownerId,
            transferId: settle.transferId,
            corridor: 'resolved_by_global',
          },
        })
        .where(eq(walletTransactions.id, txnId));

      const [after] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, wallet.id))
        .limit(1);

      return { success: true, transferId: settle.transferId, newBalanceCents: after?.balanceCents ?? null } as {
        success: boolean;
        transferId?: string;
        newBalanceCents?: number;
      };
    },
  );

  if (!result.success) {
    return { success: false, error: result.error ?? 'Unable to move funds to Stripe.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { action: 'resolve_wallet_to_connect', amountCents, ownerId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

export async function requestPayoutAction(
  amountCents: number,
  _speed: 'standard' | 'instant' = 'standard',
  ownerId?: string,
  requestId?: string,
): Promise<{ success: boolean; payoutId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }
  if (!requestId) return { success: false, error: 'A payout request ID is required.' };

  const check = await rateLimit(
    `wallet:${currentUserId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  return {
    success: false,
    error:
      'Bank payout execution is owned by Global. This Group instance cannot create a Stripe payout directly.',
  };
}

/**
 * Read-only balances for an owner's payments account beyond the Connect balance:
 * the Treasury FinancialAccount cash balance and the linked EXTERNAL bank balance
 * (Financial Connections). Both degrade gracefully — returns `null` for each when
 * not enabled / not linked — so the treasury + wallet views can render them
 * without breaking before Stripe Treasury/Financial-Connections are live.
 */
export async function getPaymentBalancesAction(ownerId?: string): Promise<{
  success: boolean;
  externalBank?: { current: Record<string, number>; available: Record<string, number>; asOf: number | null } | null;
  treasury?: { cash: Record<string, number> } | null;
  /** True when the FC flag is on and a Connect account exists — the UI may offer bank linking. */
  canLinkBank?: boolean;
  /** True when a Financial Connections account id is already saved on the wallet. */
  bankLinked?: boolean;
  /** True when the Treasury flag is on, a Connect account exists, and no FA is provisioned yet. */
  canProvisionTreasury?: boolean;
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  try {
    const target = await resolveManagedWalletTarget(currentUserId, ownerId);
    const [wallet] = await db
      .select({ metadata: wallets.metadata })
      .from(wallets)
      .where(eq(wallets.id, target.walletId))
      .limit(1);
    const meta = (wallet?.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = typeof meta.stripeConnectAccountId === 'string' ? meta.stripeConnectAccountId : undefined;
    const faId = typeof meta.stripeFinancialAccountId === 'string' ? meta.stripeFinancialAccountId : undefined;
    const fcId = typeof meta.financialConnectionsAccountId === 'string' ? meta.financialConnectionsAccountId : undefined;
    if (!connectAccountId) {
      return { success: true, externalBank: null, treasury: null, canLinkBank: false, bankLinked: false, canProvisionTreasury: false };
    }

    const [externalBank, treasuryBalance] = await Promise.all([
      fcId ? getExternalBankBalance(connectAccountId, fcId).catch(() => null) : Promise.resolve(null),
      faId ? getTreasuryFinancialAccountBalance(connectAccountId, faId).catch(() => null) : Promise.resolve(null),
    ]);

    return {
      success: true,
      externalBank,
      treasury: treasuryBalance ? { cash: treasuryBalance.cash } : null,
      canLinkBank: isFinancialConnectionsEnabled(),
      bankLinked: Boolean(fcId),
      canProvisionTreasury: isTreasuryEnabled() && !faId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load balances.' };
  }
}

/**
 * Provision the Stripe Treasury FinancialAccount for an owner's treasury and
 * persist its id on the wallet (`metadata.stripeFinancialAccountId`). Idempotent —
 * returns the existing id when one is already stored. Requires the platform to be
 * Treasury-approved + STRIPE_TREASURY_ENABLED (see stripe-treasury.ts).
 */
export async function provisionTreasuryFinancialAccountAction(ownerId?: string): Promise<{
  success: boolean;
  financialAccountId?: string;
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }
  if (!isTreasuryEnabled()) {
    return { success: false, error: 'Stripe Treasury is not enabled on this platform yet.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'provisionTreasuryFinancialAccountAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { ownerId },
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

      const existingFaId = walletMeta.stripeFinancialAccountId as string | undefined;
      if (existingFaId) {
        return { success: true, financialAccountId: existingFaId } as {
          success: boolean;
          financialAccountId?: string;
          error?: string;
        };
      }

      const financialAccount = await createTreasuryFinancialAccount({
        connectedAccountId: connectAccountId,
        metadata: {
          walletId: wallet.id,
          ownerId: target.ownerId,
          treasuryKind: target.walletType,
        },
      });

      await db
        .update(wallets)
        .set({
          metadata: { ...walletMeta, stripeFinancialAccountId: financialAccount.id },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));

      return { success: true, financialAccountId: financialAccount.id } as {
        success: boolean;
        financialAccountId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('provisionTreasuryFinancialAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to provision the treasury account.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { action: 'provision_financial_account', ownerId, financialAccountId: result.data?.financialAccountId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Mint a Financial Connections session for the owner's connected account so the
 * frontend can open the secure bank-link modal (`collectFinancialConnectionsAccounts`).
 * Returns the session client_secret plus the connected-account id the Stripe.js
 * instance must be scoped to. No persistence — pair with saveLinkedBankAccountAction.
 */
export async function createBankLinkSessionAction(ownerId?: string): Promise<{
  success: boolean;
  clientSecret?: string;
  connectAccountId?: string;
  error?: string;
}> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }
  if (!isFinancialConnectionsEnabled()) {
    return { success: false, error: 'Bank linking is not enabled on this platform yet.' };
  }

  try {
    const target = await resolveManagedWalletTarget(currentUserId, ownerId);
    const [wallet] = await db
      .select({ metadata: wallets.metadata })
      .from(wallets)
      .where(eq(wallets.id, target.walletId))
      .limit(1);

    const walletMeta = (wallet?.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;
    if (!connectAccountId) {
      return { success: false, error: 'No payment account found. Set up payments first.' };
    }

    const session = await createFinancialConnectionsSession(connectAccountId);
    if (!session.client_secret) {
      return { success: false, error: 'Stripe did not return a session secret.' };
    }

    return { success: true, clientSecret: session.client_secret, connectAccountId };
  } catch (error) {
    console.error('createBankLinkSessionAction failed:', error);
    return { success: false, error: 'Unable to start bank linking. Please try again.' };
  }
}

/**
 * Persist the Financial Connections account id returned by the bank-link modal
 * onto the owner's wallet (`metadata.financialConnectionsAccountId`). Validates
 * the id against Stripe under the connected account before saving — an id that
 * does not belong to this connected account fails retrieval and is rejected.
 */
export async function saveLinkedBankAccountAction(
  financialConnectionsAccountId: string,
  ownerId?: string,
): Promise<{ success: boolean; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    return { success: false, error: 'You must be logged in.' };
  }
  if (!isFinancialConnectionsEnabled()) {
    return { success: false, error: 'Bank linking is not enabled on this platform yet.' };
  }
  if (typeof financialConnectionsAccountId !== 'string' || !financialConnectionsAccountId.startsWith('fca_')) {
    return { success: false, error: 'Invalid linked bank account reference.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'saveLinkedBankAccountAction',
      actorId: currentUserId,
      targetAgentId: currentUserId,
      payload: { ownerId, financialConnectionsAccountId },
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

      // Throws when the fca_ id is not accessible under this connected account.
      await retrieveFinancialConnectionsAccount(connectAccountId, financialConnectionsAccountId);

      await db
        .update(wallets)
        .set({
          metadata: { ...walletMeta, financialConnectionsAccountId },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));

      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('saveLinkedBankAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to save the linked bank account.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: currentUserId,
    actorId: currentUserId,
    payload: { action: 'link_bank_account', ownerId },
  }).catch(() => {});

  return result.data ?? { success: true };
}
