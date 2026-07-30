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

/**
 * Whether NEW payment setups create Custom (controller-based) connected accounts
 * instead of Express. Verified 2026-07-01: hosted Account-Links onboarding works
 * for controller accounts with requirement_collection=application, so flipping
 * this needs no bespoke KYC UI. Existing Express accounts are unaffected.
 */
export function isCustomConnectEnabled(): boolean {
  return process.env.STRIPE_CUSTOM_ACCOUNTS_ENABLED === "true";
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

/**
 * Retrieve a linked Financial Connections account (under the connected account's
 * Stripe-Account header). Used to VALIDATE an fca_ id belongs to this connected
 * account before persisting it — retrieval throws when it does not.
 */
export async function retrieveFinancialConnectionsAccount(
  connectedAccountId: string,
  financialConnectionsAccountId: string,
): Promise<Stripe.FinancialConnections.Account> {
  const stripe = getStripe();
  return stripe.financialConnections.accounts.retrieve(financialConnectionsAccountId, {
    stripeAccount: connectedAccountId,
  });
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

// ---------------------------------------------------------------------------
// Issuing — cards tethered to a Treasury FinancialAccount
// ---------------------------------------------------------------------------

/**
 * Issuing requires its own Stripe program approval, separate from Treasury
 * (the 2026-07-01 enablement probe: "card_issuing can only be requested if
 * your platform has been onboarded on Stripe Issuing already"). Until
 * approved AND this flag is set, card helpers refuse instead of erroring
 * opaquely at the Stripe API.
 */
export function isIssuingEnabled(): boolean {
  return process.env.STRIPE_ISSUING_ENABLED === "true";
}

export interface CreateIssuingCardholderInput {
  /** Connected account hosting the card program (the parent group's account). */
  connectedAccountId: string;
  /** Display name — the subgroup/circle/fund name (used to derive the cardholder name). */
  name: string;
  email?: string;
  /**
   * The RESPONSIBLE PERSON for the treasury card. Stripe Issuing cardholders
   * must be `individual` (a `company` cardholder cannot activate a card), and
   * the person must clear KYC (name + dob) and accept the card-issuing terms
   * before a card issued to them activates. A treasury card is therefore held
   * by a designated steward, not the org entity. When omitted, the cardholder
   * is created but its card stays pending until these are supplied.
   */
  responsiblePerson?: {
    firstName: string;
    lastName: string;
    dob?: { day: number; month: number; year: number };
    phoneNumber?: string;
    email?: string;
  };
  /** IP recorded for the card-issuing terms acceptance (the issuing admin's). */
  termsAcceptanceIp?: string;
  /** Billing address is REQUIRED by Issuing; default to the platform address envs. */
  billingAddress?: {
    line1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  metadata?: Record<string, string>;
}

/** Splits a display name into first/last for an individual cardholder. */
function splitPersonName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] || "Treasury", last: "Steward" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Create an INDIVIDUAL Issuing cardholder for a treasury card on the hosting
 * connected account (Stripe requires `individual`, not `company` — a company
 * cardholder cannot activate a card). The responsible steward's name + dob and
 * the card-issuing terms acceptance are what let an issued card go active; the
 * terms acceptance is recorded programmatically for the issuing admin.
 */
export async function createIssuingCardholder(
  input: CreateIssuingCardholderInput,
): Promise<Stripe.Issuing.Cardholder> {
  if (!isIssuingEnabled()) {
    throw new Error("Stripe Issuing is not enabled on this platform (STRIPE_ISSUING_ENABLED).");
  }
  const stripe = getStripe();
  const billing = input.billingAddress ?? {
    line1: process.env.PLATFORM_BILLING_LINE1 ?? "1 Main St",
    city: process.env.PLATFORM_BILLING_CITY ?? "Boulder",
    state: process.env.PLATFORM_BILLING_STATE ?? "CO",
    postal_code: process.env.PLATFORM_BILLING_POSTAL ?? "80302",
    country: "US",
  };
  const person = input.responsiblePerson;
  const derived = splitPersonName(input.name);
  const firstName = person?.firstName ?? derived.first;
  const lastName = person?.lastName ?? derived.last;
  const email = person?.email ?? input.email;

  const individual: Stripe.Issuing.CardholderCreateParams.Individual = {
    first_name: firstName,
    last_name: lastName,
    card_issuing: {
      user_terms_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: input.termsAcceptanceIp ?? "0.0.0.0",
      },
    },
    ...(person?.dob ? { dob: person.dob } : {}),
  };

  return stripe.issuing.cardholders.create(
    {
      type: "individual",
      name: `${firstName} ${lastName}`.trim(),
      email,
      ...(person?.phoneNumber ? { phone_number: person.phoneNumber } : {}),
      billing: { address: billing },
      individual,
      metadata: input.metadata,
    },
    { stripeAccount: input.connectedAccountId },
  );
}

export interface IssueTreasuryCardInput {
  /** Connected account hosting the FinancialAccount + cardholder. */
  connectedAccountId: string;
  cardholderId: string;
  /** The Treasury FinancialAccount the card draws from (funds isolation). */
  financialAccountId: string;
  /** Spend ceiling per interval, in cents. Platform liability control — always set. */
  spendingLimitCents: number;
  spendingLimitInterval?: "daily" | "weekly" | "monthly" | "yearly" | "all_time";
  metadata?: Record<string, string>;
}

/**
 * Issue a VIRTUAL card tethered to a treasury FinancialAccount. The card can
 * only spend that FA's balance, and the mandatory spending limit caps
 * platform liability (per-connected-account caps are required by the
 * architecture doc §4.2).
 */
export async function createTreasuryIssuingCard(
  input: IssueTreasuryCardInput,
): Promise<Stripe.Issuing.Card> {
  if (!isIssuingEnabled()) {
    throw new Error("Stripe Issuing is not enabled on this platform (STRIPE_ISSUING_ENABLED).");
  }
  if (!Number.isInteger(input.spendingLimitCents) || input.spendingLimitCents <= 0) {
    throw new Error("A positive integer spendingLimitCents is required for issued cards.");
  }
  const stripe = getStripe();
  return stripe.issuing.cards.create(
    {
      cardholder: input.cardholderId,
      currency: "usd",
      type: "virtual",
      financial_account: input.financialAccountId,
      status: "active",
      spending_controls: {
        spending_limits: [
          {
            amount: input.spendingLimitCents,
            interval: input.spendingLimitInterval ?? "monthly",
          },
        ],
      },
      metadata: input.metadata,
    } as Stripe.Issuing.CardCreateParams,
    { stripeAccount: input.connectedAccountId },
  );
}

export interface IssuedCardSummary {
  id: string;
  last4: string;
  status: string;
  type: string;
  spendingLimitCents: number | null;
  spendingLimitInterval: string | null;
}

/** List cards issued under a cardholder (a treasury), newest first. */
export async function listIssuingCardsForCardholder(
  connectedAccountId: string,
  cardholderId: string,
): Promise<IssuedCardSummary[]> {
  if (!isIssuingEnabled()) return [];
  const stripe = getStripe();
  const cards = await stripe.issuing.cards.list(
    { cardholder: cardholderId, limit: 20 },
    { stripeAccount: connectedAccountId },
  );
  return cards.data.map((card) => {
    const limit = card.spending_controls?.spending_limits?.[0];
    return {
      id: card.id,
      last4: card.last4,
      status: card.status,
      type: card.type,
      spendingLimitCents: limit?.amount ?? null,
      spendingLimitInterval: limit?.interval ?? null,
    };
  });
}

/**
 * Total settled Issuing card SPEND for a cardholder, in cents (used by the
 * project budget rollup's FA-card component). Stripe records a purchase capture
 * as a NEGATIVE `amount` and a refund as positive, so net spend is
 * `-sum(amount)` clamped at zero. Degrades to `0` when Issuing is disabled or
 * the account has no transactions — the budget treats a missing/dormant card
 * lane as zero card spend, never an error.
 *
 * @param connectedAccountId The connected account hosting the cardholder.
 * @param cardholderId The Issuing cardholder whose card spend to total.
 * @param options.createdGteEpoch Optional lower bound (Unix seconds) for a date-ranged report.
 * @returns Non-negative integer cents of net card spend.
 */
export async function sumIssuingSpendForCardholder(
  connectedAccountId: string,
  cardholderId: string,
  options?: { createdGteEpoch?: number; createdLteEpoch?: number },
): Promise<number> {
  if (!isIssuingEnabled()) return 0;
  const stripe = getStripe();
  // Both bounds are honoured so a date-ranged budget report cannot mix a
  // period-bounded lower edge with an unbounded upper one (audit T1-5).
  const created: Stripe.RangeQueryParam = {};
  if (options?.createdGteEpoch !== undefined) created.gte = options.createdGteEpoch;
  if (options?.createdLteEpoch !== undefined) created.lte = options.createdLteEpoch;
  const params: Stripe.Issuing.TransactionListParams = {
    cardholder: cardholderId,
    limit: 100,
    ...(Object.keys(created).length > 0 ? { created } : {}),
  };

  let totalCents = 0;
  for await (const txn of stripe.issuing.transactions.list(params, {
    stripeAccount: connectedAccountId,
  })) {
    // Purchases are negative, refunds positive; net outflow is -sum(amount).
    totalCents += -txn.amount;
  }
  return Math.max(0, totalCents);
}

/** True when the platform Stripe key is present (so callers can no-op cleanly). */
export function isPaymentsConfigured(): boolean {
  return isStripeConfigured();
}
