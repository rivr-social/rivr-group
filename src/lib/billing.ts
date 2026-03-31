/**
 * Billing and Stripe subscription integration helpers.
 *
 * Purpose:
 * Encapsulates Stripe client lifecycle, membership tier configuration, Stripe
 * customer lookup/creation, active subscription checks, entitlement checks,
 * and hosted Checkout session creation.
 *
 * Key exports:
 * `getStripe`, `MEMBERSHIP_TIERS`, `TIER_HIERARCHY`, `tierForPriceId`,
 * `getOrCreateStripeCustomer`, `getActiveSubscription`, `hasEntitlement`,
 * and `createCheckoutSession`.
 *
 * Dependencies:
 * Drizzle database client/schema, Stripe SDK, and Stripe integration config
 * helpers from `@/lib/integrations/stripe`.
 */
import Stripe from 'stripe';
import { db } from '@/db';
import { agents, subscriptions, type MembershipTier } from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { getStripeSecretKey, STRIPE_API_VERSION } from '@/lib/integrations/stripe';
import { getMembershipConnectSurchargeCents } from '@/lib/membership-pricing';

/**
 * Lazily-initialized Stripe client (server-side only).
 * Avoids crashing at module load if STRIPE_SECRET_KEY is absent in dev.
 */
let _stripe: Stripe | null = null;

/**
 * Returns a singleton Stripe client configured from server environment.
 *
 * @returns Initialized Stripe SDK client instance.
 * @throws {Error} When Stripe secret key/configuration is invalid.
 * @example
 * ```ts
 * const stripe = getStripe();
 * const customer = await stripe.customers.retrieve('cus_123');
 * ```
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getStripeSecretKey(), {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      typescript: true,
    });
  }
  return _stripe;
}

/**
 * Membership tier configuration keyed by tier slug.
 * Price IDs come from environment variables configured in the Stripe dashboard.
 *
 * Configuration pattern:
 * Environment-driven IDs allow per-environment Stripe products without code
 * changes. Missing values are validated at checkout-session creation time.
 */
export const MEMBERSHIP_TIERS: Record<
  MembershipTier,
  {
    name: string;
    monthlyPriceId: string | undefined;
    yearlyPriceId: string | undefined;
  }
> = {
  basic: {
    name: 'Basic',
    monthlyPriceId: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    yearlyPriceId: process.env.STRIPE_PRICE_BASIC_YEARLY,
  },
  host: {
    name: 'Host',
    monthlyPriceId: process.env.STRIPE_PRICE_HOST_MONTHLY,
    yearlyPriceId: process.env.STRIPE_PRICE_HOST_YEARLY,
  },
  seller: {
    name: 'Seller',
    monthlyPriceId: process.env.STRIPE_PRICE_SELLER_MONTHLY,
    yearlyPriceId: process.env.STRIPE_PRICE_SELLER_YEARLY,
  },
  organizer: {
    name: 'Organizer',
    monthlyPriceId: process.env.STRIPE_PRICE_ORGANIZER_MONTHLY,
    yearlyPriceId: process.env.STRIPE_PRICE_ORGANIZER_YEARLY,
  },
  steward: {
    name: 'Steward',
    monthlyPriceId: process.env.STRIPE_PRICE_STEWARD_MONTHLY,
    yearlyPriceId: process.env.STRIPE_PRICE_STEWARD_YEARLY,
  },
};

export const DEFAULT_MEMBERSHIP_TRIAL_DAYS = 30;

/** Tier hierarchy from lowest to highest for entitlement comparison. */
export const TIER_HIERARCHY: readonly MembershipTier[] = [
  'basic',
  'host',
  'seller',
  'organizer',
  'steward',
] as const;

/**
 * Resolves which membership tier a Stripe price ID maps to.
 *
 * @param priceId Stripe recurring price identifier.
 * @returns Matched membership tier, or `null` when no configured tier matches.
 * @throws {Error} Propagates unexpected runtime errors.
 * @example
 * ```ts
 * const tier = tierForPriceId('price_abc123');
 * // => 'host' | 'seller' | 'organizer' | 'steward' | null
 * ```
 */
export function tierForPriceId(priceId: string): MembershipTier | null {
  for (const [tier, config] of Object.entries(MEMBERSHIP_TIERS)) {
    if (config.monthlyPriceId === priceId || config.yearlyPriceId === priceId) {
      return tier as MembershipTier;
    }
  }
  return null;
}

/**
 * Returns (or creates) a Stripe customer for the given agent.
 * Searches by email first to avoid duplicates, then falls back to creation.
 *
 * @param agentId Internal agent identifier.
 * @returns Stripe customer ID for the agent.
 * @throws {Error} When the agent does not exist or Stripe/database operations fail.
 * @example
 * ```ts
 * const customerId = await getOrCreateStripeCustomer(agentId);
 * ```
 */
export async function getOrCreateStripeCustomer(agentId: string): Promise<string> {
  // Check if the agent already has a subscription record with a Stripe customer ID
  const [existingSub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.agentId, agentId))
    .limit(1);

  if (existingSub) {
    return existingSub.stripeCustomerId;
  }

  // Fetch agent details
  const [agent] = await db
    .select({ id: agents.id, email: agents.email, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const stripe = getStripe();

  // Search by email first to reduce accidental duplicate customer records.
  // This is best-effort deduplication and relies on trusted agent email data.
  if (agent.email) {
    const existing = await stripe.customers.list({
      email: agent.email,
      limit: 1,
    });
    if (existing.data.length > 0) {
      return existing.data[0].id;
    }
  }

  // Persist agentId metadata for webhook reconciliation and auditability.
  const customer = await stripe.customers.create({
    email: agent.email ?? undefined,
    name: agent.name,
    metadata: { agentId: agent.id },
  });

  return customer.id;
}

/**
 * Returns the active subscription for an agent (if any).
 *
 * @param agentId Internal agent identifier.
 * @returns Active or trialing subscription row, or `null` if none exists.
 * @throws {Error} When database queries fail.
 * @example
 * ```ts
 * const sub = await getActiveSubscription(agentId);
 * if (sub) {
 *   console.log(sub.membershipTier);
 * }
 * ```
 */
export async function getActiveSubscription(agentId: string) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.agentId, agentId),
        or(
          eq(subscriptions.status, 'active'),
          eq(subscriptions.status, 'trialing'),
        ),
      )
    )
    .limit(1);

  return sub ?? null;
}

/**
 * Returns ALL active or trialing subscriptions for an agent.
 *
 * @param agentId Internal agent identifier.
 * @returns Array of active/trialing subscription rows.
 */
export async function getAllActiveSubscriptions(agentId: string) {
  const activeSubs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.agentId, agentId),
        eq(subscriptions.status, 'active'),
      )
    );

  const trialingSubs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.agentId, agentId),
        eq(subscriptions.status, 'trialing'),
      )
    );

  return [...activeSubs, ...trialingSubs];
}

/**
 * Checks whether an agent's active subscription grants access to (at least)
 * the requested tier. Higher tiers include all lower-tier entitlements.
 *
 * @param agentId Internal agent identifier.
 * @param requiredTier Tier required for the requested feature.
 * @returns `true` if active/trialing subscription tier is at or above required tier.
 * @throws {Error} When subscription lookup fails.
 * @example
 * ```ts
 * const canAccess = await hasEntitlement(agentId, 'organizer');
 * ```
 */
export async function hasEntitlement(
  agentId: string,
  requiredTier: MembershipTier
): Promise<boolean> {
  const sub = await getActiveSubscription(agentId);
  if (!sub) return false;

  // Comparison is ordinal based on explicit hierarchy ordering above.
  const agentTierIndex = TIER_HIERARCHY.indexOf(sub.membershipTier);
  const requiredIndex = TIER_HIERARCHY.indexOf(requiredTier);
  return agentTierIndex >= requiredIndex;
}

/**
 * Creates a Stripe Checkout Session for the given tier + billing period.
 * Returns the session URL to redirect the user to.
 *
 * @param agentId Internal agent identifier purchasing/upgrading membership.
 * @param tier Requested membership tier.
 * @param billingPeriod Billing cadence (`monthly` or `yearly`).
 * @returns Hosted Stripe Checkout URL.
 * @throws {Error} When tier/price config is invalid or Stripe fails to create session.
 * @example
 * ```ts
 * const url = await createCheckoutSession(agentId, 'seller', 'monthly');
 * ```
 */
export async function createCheckoutSession(
  agentId: string,
  tier: MembershipTier,
  billingPeriod: 'monthly' | 'yearly',
  options?: {
    trialDays?: number;
    successPath?: string;
    cancelPath?: string;
  }
): Promise<string> {
  const tierConfig = MEMBERSHIP_TIERS[tier];
  if (!tierConfig) {
    throw new Error(`Unknown membership tier: ${tier}`);
  }

  const priceId =
    billingPeriod === 'monthly'
      ? tierConfig.monthlyPriceId
      : tierConfig.yearlyPriceId;

  if (!priceId) {
    throw new Error(
      `Stripe price ID not configured for ${tier} (${billingPeriod}). ` +
        `Set STRIPE_PRICE_${tier.toUpperCase()}_${billingPeriod.toUpperCase()} in environment.`
    );
  }

  const customerId = await getOrCreateStripeCustomer(agentId);
  const stripe = getStripe();

  // NEXTAUTH_URL anchors redirect URLs to a trusted host in production.
  // Localhost fallback keeps local development functional.
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const successUrl = new URL(
    options?.successPath ? options.successPath : '/api/stripe/subscription-success',
    baseUrl,
  );
  const cancelUrl = new URL(
    options?.cancelPath ? options.cancelPath : `/products/membership-${tier}?subscription=canceled`,
    baseUrl,
  );

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [
      { price: priceId, quantity: 1 },
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Connect settlement fee',
          },
          recurring: {
            interval: billingPeriod === 'monthly' ? 'month' : 'year',
          },
          unit_amount: getMembershipConnectSurchargeCents(billingPeriod),
        },
        quantity: 1,
      },
    ],
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    payment_method_collection: 'always',
    subscription_data: {
      metadata: {
        agentId,
        tier,
        membershipConnectSurchargeCents: String(
          getMembershipConnectSurchargeCents(billingPeriod),
        ),
      },
      ...(options?.trialDays && options.trialDays > 0
        ? { trial_period_days: options.trialDays }
        : {}),
    },
    metadata: {
      agentId,
      tier,
      billingPeriod,
      membershipConnectSurchargeCents: String(
        getMembershipConnectSurchargeCents(billingPeriod),
      ),
    },
  });

  if (!session.url) {
    throw new Error('Stripe returned a checkout session without a URL');
  }

  return session.url;
}
