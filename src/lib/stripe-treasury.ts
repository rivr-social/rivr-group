/**
 * Stripe Treasury / Issuing / Financial Connections foundation (Phase-0/1 of the
 * payments architecture — see
 * docs/active/payments-stripe-connect-treasury-architecture-2026-07-01.md).
 *
 * Grounded in the current Stripe API (SDK stripe@20, apiVersion
 * 2024-12-18.acacia). All helpers here are ADDITIVE and DORMANT until the
 * platform is approved for Treasury/Issuing and the flag is set — they do not
 * touch existing charge/settlement flows. Balance READS degrade gracefully.
 *
 * Account model: Custom Connect accounts using CONTROLLER properties
 * (requirement_collection=application, dashboard.type=none, losses/fees=application)
 * — the only type that can host Treasury + Issuing AND let the platform read a
 * connected account's external bank balance via Financial Connections.
 */

import type Stripe from "stripe";
import { getStripe } from "@/lib/billing";
import { isStripeConfigured } from "@/lib/integrations/stripe";

/**
 * Treasury + Issuing require Stripe program approval (US-only, KYC/KYB, platform
 * loss liability). Until the platform is approved AND this flag is set, we do
 * NOT request the treasury/card_issuing capabilities (requesting them on an
 * unapproved platform errors at account creation) and we skip FinancialAccount
 * provisioning. Flip STRIPE_TREASURY_ENABLED=true once approved + tested in test mode.
 */
export function isTreasuryEnabled(): boolean {
  return process.env.STRIPE_TREASURY_ENABLED === "true";
}

/** Whether Financial Connections balance reads are enabled (dashboard toggle + flag). */
export function isFinancialConnectionsEnabled(): boolean {
  return process.env.STRIPE_FINANCIAL_CONNECTIONS_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Custom Connect account (controller-based)
// ---------------------------------------------------------------------------

export interface CreateCustomConnectAccountInput {
  agentId: string;
  email?: string;
  country?: string;
  metadata?: Record<string, string>;
}

/**
 * Create a Custom (controller-based) connected account. Always requests
 * card_payments + transfers; requests treasury + card_issuing only when the
 * platform is Treasury-approved (see {@link isTreasuryEnabled}) so account
 * creation never fails on an unapproved platform.
 */
export async function createCustomConnectAccount(
  input: CreateCustomConnectAccountInput,
): Promise<Stripe.Account> {
  const stripe = getStripe();
  const treasury = isTreasuryEnabled();

  const capabilities: Stripe.AccountCreateParams.Capabilities = {
    card_payments: { requested: true },
    transfers: { requested: true },
    ...(treasury
      ? {
          treasury: { requested: true },
          card_issuing: { requested: true },
          us_bank_account_ach_payments: { requested: true },
        }
      : {}),
  };

  return stripe.accounts.create({
    country: input.country ?? "US",
    email: input.email,
    capabilities,
    controller: {
      stripe_dashboard: { type: "none" },
      requirement_collection: "application",
      fees: { payer: "application" },
      losses: { payments: "application" },
    },
    metadata: { agentId: input.agentId, ...(input.metadata ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// Treasury FinancialAccount (one per treasury: group / subgroup / project)
// ---------------------------------------------------------------------------

export interface CreateFinancialAccountInput {
  /** The connected account that will HOST this FinancialAccount. */
  connectedAccountId: string;
  /** Treasury ref, e.g. { treasuryKind: 'group'|'subgroup'|'project', treasuryId } — stored as FA metadata. */
  metadata?: Record<string, string>;
  supportedCurrencies?: string[];
}

/**
 * Provision a Treasury FinancialAccount ON a connected account (via the
 * Stripe-Account header). One FA per treasury. No-op guard when Treasury is not
 * yet enabled.
 */
export async function createTreasuryFinancialAccount(
  input: CreateFinancialAccountInput,
): Promise<Stripe.Treasury.FinancialAccount> {
  if (!isTreasuryEnabled()) {
    throw new Error("Treasury is not enabled on this platform (STRIPE_TREASURY_ENABLED).");
  }
  const stripe = getStripe();
  return stripe.treasury.financialAccounts.create(
    {
      supported_currencies: input.supportedCurrencies ?? ["usd"],
      features: {
        card_issuing: { requested: true },
        deposit_insurance: { requested: true },
        financial_addresses: { aba: { requested: true } },
        inbound_transfers: { ach: { requested: true } },
        intra_stripe_flows: { requested: true },
        outbound_payments: { ach: { requested: true }, us_domestic_wire: { requested: true } },
        outbound_transfers: { ach: { requested: true }, us_domestic_wire: { requested: true } },
      },
      metadata: input.metadata,
    },
    { stripeAccount: input.connectedAccountId },
  );
}

/** Read a Treasury FinancialAccount's cash balance (in cents by currency). */
export async function getTreasuryFinancialAccountBalance(
  connectedAccountId: string,
  financialAccountId: string,
): Promise<{ cash: Record<string, number>; inbound: Record<string, number>; outbound: Record<string, number> } | null> {
  if (!isTreasuryEnabled()) return null;
  const stripe = getStripe();
  const fa = await stripe.treasury.financialAccounts.retrieve(financialAccountId, {
    stripeAccount: connectedAccountId,
  });
  return {
    cash: (fa.balance?.cash ?? {}) as Record<string, number>,
    inbound: (fa.balance?.inbound_pending ?? {}) as Record<string, number>,
    outbound: (fa.balance?.outbound_pending ?? {}) as Record<string, number>,
  };
}

// ---------------------------------------------------------------------------
// Financial Connections — link + read EXTERNAL bank balances
// ---------------------------------------------------------------------------

/**
 * Create a Financial Connections session so a connected account can link its
 * external bank and share live balances/transactions with the platform. For a
 * connected account, the account holder is the account itself and the call
 * carries the Stripe-Account header. Returns the client_secret for the frontend
 * `collectFinancialConnectionsAccounts` modal.
 */
export async function createFinancialConnectionsSession(
  connectedAccountId: string,
  permissions: Array<"balances" | "transactions" | "ownership" | "payment_method"> = [
    "balances",
    "transactions",
  ],
): Promise<Stripe.FinancialConnections.Session> {
  if (!isFinancialConnectionsEnabled()) {
    throw new Error("Financial Connections is not enabled (STRIPE_FINANCIAL_CONNECTIONS_ENABLED).");
  }
  const stripe = getStripe();
  return stripe.financialConnections.sessions.create(
    {
      account_holder: { type: "account", account: connectedAccountId },
      permissions,
    },
    { stripeAccount: connectedAccountId },
  );
}

export interface ExternalBankBalance {
  current: Record<string, number>;
  available: Record<string, number>;
  asOf: number | null;
}

/**
 * Refresh and read a linked external bank account's live balance. `refresh`
 * triggers an on-demand pull before we read (recommended before large moves).
 */
export async function getExternalBankBalance(
  connectedAccountId: string,
  financialConnectionsAccountId: string,
  refresh = true,
): Promise<ExternalBankBalance | null> {
  if (!isFinancialConnectionsEnabled()) return null;
  const stripe = getStripe();
  const opts = { stripeAccount: connectedAccountId };
  if (refresh) {
    await stripe.financialConnections.accounts
      .refresh(financialConnectionsAccountId, { features: ["balance"] }, opts)
      .catch(() => undefined);
  }
  const account = await stripe.financialConnections.accounts.retrieve(
    financialConnectionsAccountId,
    opts,
  );
  const balance = account.balance;
  if (!balance) return null;
  return {
    current: (balance.current ?? {}) as Record<string, number>,
    available: (balance.cash?.available ?? {}) as Record<string, number>,
    asOf: balance.as_of ?? null,
  };
}

/** True when the platform Stripe key is present (so callers can no-op cleanly). */
export function isPaymentsConfigured(): boolean {
  return isStripeConfigured();
}
