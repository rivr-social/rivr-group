/**
 * Stripe Connect Express account management helpers.
 *
 * Purpose:
 * Encapsulates Stripe Connect Express account creation, onboarding link
 * generation, account status retrieval, balance queries, payout creation,
 * and Express dashboard login link generation.
 *
 * Key exports:
 * `createConnectAccount`, `createAccountLink`, `getAccountStatus`,
 * `getConnectBalance`, `createPayout`, `createLoginLink`.
 *
 * Dependencies:
 * Shared Stripe SDK client from `@/lib/billing`.
 */
import { getStripe } from '@/lib/billing';

/**
 * Creates a new Stripe Connect Express account for the given agent.
 * The account is configured with card_payments and transfers capabilities,
 * which are required for marketplace-style destination charges.
 *
 * @param agentId Internal agent identifier stored in account metadata.
 * @param email Email address associated with the Connect account.
 * @returns Stripe Express account object.
 * @throws {Error} When Stripe fails to create the account.
 * @example
 * ```ts
 * const account = await createConnectAccount(agentId, 'seller@example.com');
 * // account.id => 'acct_...'
 * ```
 */
export async function createConnectAccount(
  agentId: string,
  email?: string,
  metadata?: Record<string, string>
) {
  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    ...(email ? { email } : {}),
    metadata: { agentId, ...(metadata ?? {}) },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
  return account;
}

/**
 * Creates a Stripe account onboarding link for an Express Connect account.
 * The user should be redirected to this URL to complete identity verification
 * and account setup in Stripe's hosted onboarding flow.
 *
 * @param connectAccountId Stripe Connect account identifier (e.g. `acct_...`).
 * @param returnUrl URL to redirect to after successful onboarding completion.
 * @param refreshUrl URL to redirect to if the onboarding link expires or is invalid.
 * @returns Onboarding URL string.
 * @throws {Error} When Stripe fails to create the account link.
 * @example
 * ```ts
 * const url = await createAccountLink(
 *   'acct_123',
 *   'https://rivr.app/connect/return',
 *   'https://rivr.app/connect/refresh',
 * );
 * // redirect user to url
 * ```
 */
export async function createAccountLink(
  connectAccountId: string,
  returnUrl: string,
  refreshUrl: string
): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: connectAccountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return link.url;
}

/**
 * Retrieves the current onboarding and payout status of a Connect account.
 * Use this to determine whether an account can accept charges and receive payouts.
 *
 * @param connectAccountId Stripe Connect account identifier (e.g. `acct_...`).
 * @returns Object with `chargesEnabled`, `payoutsEnabled`, and `detailsSubmitted` flags.
 * @throws {Error} When the account does not exist or Stripe retrieval fails.
 * @example
 * ```ts
 * const status = await getAccountStatus('acct_123');
 * if (status.chargesEnabled && status.payoutsEnabled) {
 *   // account is fully onboarded
 * }
 * ```
 */
export async function getAccountStatus(
  connectAccountId: string
): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(connectAccountId);
  return {
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
  };
}

/**
 * Retrieves the available and pending USD balance for a Connect account.
 * Sums all USD entries from the balance arrays since a Connect account may
 * have multiple balance entries across source types.
 *
 * @param connectAccountId Stripe Connect account identifier (e.g. `acct_...`).
 * @returns Object with `availableCents` and `pendingCents` totals in USD.
 * @throws {Error} When Stripe balance retrieval fails.
 * @example
 * ```ts
 * const balance = await getConnectBalance('acct_123');
 * console.log(`Available: $${(balance.availableCents / 100).toFixed(2)}`);
 * ```
 */
export async function getConnectBalance(
  connectAccountId: string
): Promise<{ availableCents: number; pendingCents: number }> {
  const stripe = getStripe();
  const balance = await stripe.balance.retrieve({
    stripeAccount: connectAccountId,
  });

  const availableCents = balance.available
    .filter((b) => b.currency === 'usd')
    .reduce((sum, b) => sum + b.amount, 0);

  const pendingCents = balance.pending
    .filter((b) => b.currency === 'usd')
    .reduce((sum, b) => sum + b.amount, 0);

  return { availableCents, pendingCents };
}

/**
 * Creates a payout from a Connect account's available balance to their
 * linked bank account or debit card.
 *
 * @param connectAccountId Stripe Connect account identifier (e.g. `acct_...`).
 * @param amountCents Payout amount in cents (USD).
 * @param speed Payout delivery speed — `'standard'` (1-2 business days) or `'instant'`.
 * @returns Stripe payout object.
 * @throws {Error} When payout creation fails (e.g. insufficient balance, instant payouts not supported).
 * @example
 * ```ts
 * const payout = await createPayout('acct_123', 5000, 'standard');
 * // payout.id => 'po_...'
 * ```
 */
export async function createPayout(
  connectAccountId: string,
  amountCents: number,
  speed: 'standard' | 'instant'
) {
  const stripe = getStripe();
  const payout = await stripe.payouts.create(
    {
      amount: amountCents,
      currency: 'usd',
      method: speed === 'instant' ? 'instant' : 'standard',
    },
    { stripeAccount: connectAccountId }
  );
  return payout;
}

/**
 * Creates a login link to the Stripe Express dashboard for a Connect account.
 * The returned URL allows the connected account holder to view their
 * transactions, payouts, and account settings in Stripe's hosted dashboard.
 *
 * @param connectAccountId Stripe Connect account identifier (e.g. `acct_...`).
 * @returns Express dashboard login URL string.
 * @throws {Error} When the account has not completed onboarding or Stripe link creation fails.
 * @example
 * ```ts
 * const dashboardUrl = await createLoginLink('acct_123');
 * // redirect user to dashboardUrl
 * ```
 */
export async function createLoginLink(
  connectAccountId: string
): Promise<string> {
  const stripe = getStripe();
  const loginLink = await stripe.accounts.createLoginLink(connectAccountId);
  return loginLink.url;
}
