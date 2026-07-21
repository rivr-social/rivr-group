/**
 * Group membership subscription helpers.
 *
 * Purpose:
 * A member subscribes to a sovereign group's own membership plan (configured in
 * the group's Settings → Memberships, stored in `metadata.membershipPlans`).
 * This is distinct from the cooperative RIVR membership tiers in `/lib/billing`.
 *
 * Settlement (locked design):
 * - `connect`: when the group has completed Stripe Connect onboarding, the
 *   recurring charge is a destination charge to the group's connected account.
 *   RIVR keeps a per-member platform fee via `application_fee_percent`. The
 *   group is paid directly by Stripe.
 *
 * Pricing (2026-07-11): the member's recurring charge is grossed up over the
 * plan's face value via `computeGroupSubscriptionChargePricing` (the canonical
 * `calculateCheckoutFees` gross-up, zero flat overhead) so the PAYER covers
 * Stripe's 2.9% + 30¢ and RIVR's 5% margin while the group nets the full plan
 * price on either rail. The previous flat-5%-of-face-value model netted the
 * platform NEGATIVE on small dues.
 * - `platform_capital`: fallback when the group is NOT yet onboarded to Connect.
 *   RIVR collects the full charge and owes the group, settled internally on the
 *   existing `capital_entries` rail (see the webhook handler).
 *
 * RIVR's cut is taken at TWO independent layers (locked design):
 * 1. The sovereign group itself is a RIVR subscriber and pays the org fee
 *    through the cooperative `subscriptions` rail (unchanged, out of scope here).
 * 2. Each member subscription contributes a per-member platform fee, computed
 *    here as {@link GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT}.
 *
 * Dependencies:
 * - Stripe SDK + customer lookup from `@/lib/billing`.
 * - Group settlement wallet (carries the Connect account id) from `@/lib/wallet`.
 * - Membership plan normalization from `@/lib/group-memberships`.
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { groupMembershipSubscriptions, ledger, type NewLedgerEntry } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getStripe, getOrCreateStripeCustomer } from '@/lib/billing';
import { buildAutomaticTax, STRIPE_TAX_CODE_DEFAULT, RIVR_TAX_BEHAVIOR } from '@/lib/stripe-tax';
import { getSettlementWalletForAgent } from '@/lib/wallet';
import type { GroupMembershipPlan } from '@/lib/group-memberships';
import type { GroupSubscriptionSettlementRail } from '@/db/schema';
import {
  planAmountCents,
  computeGroupSubscriptionChargePricing,
  chargePricingFromBuyerTotal,
  type GroupSubscriptionBillingPeriod,
  type GroupSubscriptionChargePricing,
} from '@/lib/group-subscription-pricing';

export {
  GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT,
  planAmountCents,
  computePlatformFeeCents,
  computeGroupSubscriptionChargePricing,
} from '@/lib/group-subscription-pricing';
export type { GroupSubscriptionBillingPeriod } from '@/lib/group-subscription-pricing';

export interface GroupConnectSettlement {
  rail: GroupSubscriptionSettlementRail;
  connectAccountId: string | null;
}

/**
 * Resolves which settlement rail a group can use right now.
 *
 * Reads the group's settlement wallet metadata (where `account.updated`
 * webhooks persist Connect status). Returns the `connect` rail only when the
 * group has a Connect account that can accept charges; otherwise falls back to
 * `platform_capital`.
 *
 * @param groupId Group agent id.
 * @returns Resolved rail and the Connect account id when applicable.
 */
export async function resolveGroupSettlement(groupId: string): Promise<GroupConnectSettlement> {
  const wallet = await getSettlementWalletForAgent(groupId);
  const meta = (wallet.metadata ?? {}) as Record<string, unknown>;
  const connectAccountId =
    typeof meta.stripeConnectAccountId === 'string' ? meta.stripeConnectAccountId : null;
  const chargesEnabled = meta.connectChargesEnabled === true;

  if (connectAccountId && chargesEnabled) {
    return { rail: 'connect', connectAccountId };
  }
  return { rail: 'platform_capital', connectAccountId: null };
}

export type GroupSubscriptionCheckout =
  | { kind: 'free'; membershipId: string }
  | { kind: 'checkout'; url: string };

/**
 * Creates a checkout flow for a member to subscribe to a group's plan.
 *
 * Free plans (no price for the chosen period) skip Stripe and grant membership
 * immediately. Paid plans create a Stripe subscription Checkout session on the
 * resolved settlement rail.
 *
 * @param params.memberAgentId Server-derived subscriber id (never client input).
 * @param params.groupId Group agent id being subscribed to.
 * @param params.plan The selected, normalized membership plan.
 * @param params.billingPeriod Billing cadence.
 * @returns A free-grant result or a hosted Checkout URL.
 * @throws {Error} When Stripe configuration/price is invalid or session creation fails.
 */
export async function createGroupSubscriptionCheckout(params: {
  memberAgentId: string;
  groupId: string;
  plan: GroupMembershipPlan;
  billingPeriod: GroupSubscriptionBillingPeriod;
  successPath?: string;
  cancelPath?: string;
}): Promise<GroupSubscriptionCheckout> {
  const { memberAgentId, groupId, plan, billingPeriod } = params;

  const amountCents = planAmountCents(plan, billingPeriod);

  // Free plan: grant membership directly, no Stripe involvement.
  if (amountCents === null) {
    const membershipId = await grantGroupMembership({
      memberAgentId,
      groupId,
      planId: plan.id,
      source: 'free_plan',
      expiresAt: null,
    });
    return { kind: 'free', membershipId };
  }

  const settlement = await resolveGroupSettlement(groupId);
  const customerId = await getOrCreateStripeCustomer(memberAgentId);
  const stripe = getStripe();

  const interval: Stripe.PriceCreateParams.Recurring.Interval =
    billingPeriod === 'monthly' ? 'month' : 'year';

  // The member's charge is GROSSED UP over the plan's face value so the payer
  // covers Stripe's processing fee and RIVR's per-member margin while the
  // group nets the full plan price. Taking the flat 5% out of face value made
  // the platform net NEGATIVE on small dues (toybox campaign 2026-07-11).
  const grossUpPricing = computeGroupSubscriptionChargePricing(amountCents);

  const configuredPriceId =
    billingPeriod === 'monthly' ? plan.stripePriceIdMonthly : plan.stripePriceIdYearly;

  // An admin-configured Stripe price is honored only when it already carries
  // at least the gross-up (its unit amount covers plan net + fees); otherwise
  // it would recreate the negative-net bug, so fall back to dynamic pricing.
  let pricing: GroupSubscriptionChargePricing = grossUpPricing;
  let lineItem: Stripe.Checkout.SessionCreateParams.LineItem | null = null;
  if (configuredPriceId) {
    try {
      const configuredPrice = await stripe.prices.retrieve(configuredPriceId);
      const configuredAmount = configuredPrice.unit_amount ?? 0;
      if (
        configuredPrice.currency === 'usd' &&
        configuredPrice.recurring?.interval === interval &&
        configuredAmount >= grossUpPricing.buyerTotalCents
      ) {
        pricing = chargePricingFromBuyerTotal(amountCents, configuredAmount);
        lineItem = { price: configuredPriceId, quantity: 1 };
      } else {
        console.warn(
          `Configured Stripe price ${configuredPriceId} does not cover the grossed-up dues total ` +
            `(${configuredAmount} < ${grossUpPricing.buyerTotalCents} or wrong currency/interval); ` +
            'using dynamic gross-up pricing instead.',
        );
      }
    } catch (err) {
      console.warn(
        `Configured Stripe price ${configuredPriceId} could not be retrieved; using dynamic gross-up pricing.`,
        err,
      );
    }
  }

  if (!lineItem) {
    lineItem = {
      price_data: {
        currency: 'usd',
        product_data: { name: `${plan.name} membership`, tax_code: STRIPE_TAX_CODE_DEFAULT },
        recurring: { interval },
        tax_behavior: RIVR_TAX_BEHAVIOR,
        unit_amount: pricing.buyerTotalCents,
      },
      quantity: 1,
    };
  }

  const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
  const successUrl = new URL(params.successPath ?? `/groups/${groupId}?subscribed=1`, baseUrl);
  const cancelUrl = new URL(params.cancelPath ?? `/groups/${groupId}?subscribe=canceled`, baseUrl);

  const subscriptionMetadata: Record<string, string> = {
    groupSubscription: 'true',
    memberAgentId,
    groupId,
    planId: plan.id,
    settlementRail: settlement.rail,
    applicationFeeCents: String(pricing.applicationFeeCents),
    planAmountCents: String(pricing.planAmountCents),
    buyerTotalCents: String(pricing.buyerTotalCents),
    billingPeriod,
  };

  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: subscriptionMetadata,
  };

  // Connect rail: destination charge to the group's connected account. The
  // application-fee percent is derived from the gross-up (fee ÷ buyer total),
  // so after Stripe's cut the group still nets the plan's full face value and
  // RIVR keeps its margin — a flat 5% of face value netted negative on small
  // dues because the platform (merchant of record) pays Stripe's fee here.
  if (settlement.rail === 'connect' && settlement.connectAccountId) {
    subscriptionData.application_fee_percent = pricing.applicationFeePercent;
    subscriptionData.transfer_data = { destination: settlement.connectAccountId };
    subscriptionMetadata.stripeConnectAccountId = settlement.connectAccountId;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [lineItem],
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    payment_method_collection: 'always',
    subscription_data: subscriptionData,
    metadata: subscriptionMetadata,
    // Destination-based sales tax via Stripe Tax (inert until registered). On the
    // Connect rail the charge routes to the group's connected account, so
    // RIVR-the-facilitator is the party liable to collect + remit.
    automatic_tax: buildAutomaticTax({
      platformLiable: settlement.rail === 'connect' && Boolean(settlement.connectAccountId),
    }),
    customer_update: { address: 'auto' },
  });

  if (!session.url) {
    throw new Error('Stripe returned a group subscription checkout session without a URL');
  }

  return { kind: 'checkout', url: session.url };
}

/**
 * Returns the member's currently active (or trialing) subscription plan id for
 * a group, or `null` when there is none. Used to mark the "current plan" card.
 */
export async function getActiveGroupSubscriptionPlanId(
  memberAgentId: string,
  groupId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ planId: groupMembershipSubscriptions.planId })
    .from(groupMembershipSubscriptions)
    .where(
      and(
        eq(groupMembershipSubscriptions.agentId, memberAgentId),
        eq(groupMembershipSubscriptions.groupId, groupId),
        inArray(groupMembershipSubscriptions.status, ['active', 'trialing']),
      ),
    )
    .limit(1);

  return row?.planId ?? null;
}

/**
 * Grants (or refreshes) an active group-membership ledger edge for a member,
 * idempotently. Used by the free-plan path and the paid webhook path.
 *
 * The membership edge mirrors the password-challenge join edge shape so all
 * existing membership predicates (`findActiveMembership`, `isGroupMember`,
 * member counts) recognize it.
 *
 * @returns The ledger entry id of the active membership edge.
 */
export async function grantGroupMembership(params: {
  memberAgentId: string;
  groupId: string;
  planId: string;
  source: 'free_plan' | 'subscription';
  expiresAt: Date | null;
  stripeSubscriptionId?: string;
}): Promise<string> {
  const { memberAgentId, groupId, planId, source, expiresAt, stripeSubscriptionId } = params;

  const [existing] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, memberAgentId),
        eq(ledger.objectId, groupId),
        eq(ledger.verb, 'join'),
        eq(ledger.isActive, true),
        sql`${ledger.metadata}->>'grantType' = 'membership_subscription'`,
      ),
    )
    .limit(1);

  const metadata = {
    grantType: 'membership_subscription',
    grantedAt: new Date().toISOString(),
    interactionType: 'membership',
    targetId: groupId,
    targetType: 'group',
    planId,
    source,
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
  };

  if (existing) {
    await db
      .update(ledger)
      .set({ isActive: true, expiresAt, role: 'member', metadata })
      .where(eq(ledger.id, existing.id));
    return existing.id;
  }

  const [entry] = await db
    .insert(ledger)
    .values({
      verb: 'join',
      subjectId: memberAgentId,
      objectId: groupId,
      objectType: 'agent',
      role: 'member',
      isActive: true,
      expiresAt,
      metadata,
    } as NewLedgerEntry)
    .returning({ id: ledger.id });

  return entry.id;
}

/**
 * Revokes a subscription-granted group membership edge (on cancellation).
 */
export async function revokeGroupMembership(params: {
  memberAgentId: string;
  groupId: string;
}): Promise<void> {
  await db
    .update(ledger)
    .set({ isActive: false })
    .where(
      and(
        eq(ledger.subjectId, params.memberAgentId),
        eq(ledger.objectId, params.groupId),
        eq(ledger.verb, 'join'),
        sql`${ledger.metadata}->>'grantType' = 'membership_subscription'`,
      ),
    );
}
