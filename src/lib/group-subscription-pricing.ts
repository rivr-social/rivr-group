/**
 * Pure pricing helpers for group membership subscriptions.
 *
 * Kept free of database/Stripe imports so they can be unit-tested and reused on
 * both the server (checkout builder, webhook settlement) and any client surface
 * without pulling the server-only dependency graph.
 */
import type { GroupMembershipPlan } from '@/lib/group-memberships';
import { calculateCheckoutFees } from '@/lib/checkout-fees';

/**
 * RIVR's per-member platform fee on each group membership charge, as a percent
 * of the charge amount. Applied via Stripe `application_fee_percent` on the
 * Connect rail and computed into `applicationFeeCents` on both rails.
 */
export const GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT = 5;

export type GroupSubscriptionBillingPeriod = 'monthly' | 'yearly';

/**
 * Returns the charge amount (in cents) for a plan + billing period, or `null`
 * when the plan is free for that period.
 */
export function planAmountCents(
  plan: GroupMembershipPlan,
  billingPeriod: GroupSubscriptionBillingPeriod,
): number | null {
  const amount =
    billingPeriod === 'monthly' ? plan.amountMonthlyCents : plan.amountYearlyCents;
  if (amount === null || amount <= 0) return null;
  return amount;
}

/** Computes the RIVR per-member platform fee (cents) for a charge amount. */
export function computePlatformFeeCents(amountCents: number): number {
  return Math.max(0, Math.round((amountCents * GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT) / 100));
}

export interface GroupSubscriptionChargePricing {
  /** The group's net target — the plan's face-value price for the period. */
  planAmountCents: number;
  /** What the member is actually charged each period (grossed up). */
  buyerTotalCents: number;
  /** RIVR's application fee = buyerTotal − planAmount (covers margin + Stripe). */
  applicationFeeCents: number;
  /**
   * `application_fee_percent` for the Connect rail, rounded to Stripe's
   * 2-decimal precision: applicationFeeCents / buyerTotalCents × 100.
   */
  applicationFeePercent: number;
}

/**
 * Prices a paid group-membership charge so the payer — not the platform —
 * covers Stripe's processing fee, routed through the canonical
 * `calculateCheckoutFees` gross-up (the marketplace "Model A" script).
 *
 * Why: taking the flat {@link GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT} out of
 * the plan's face value left RIVR's fee smaller than Stripe's processing cost
 * on small dues (a $10/mo plan netted the platform ≈ −9¢ on the Connect rail
 * — toybox financial-cascade campaign, 2026-07-11). Grossing the member's
 * charge up preserves the group's full face-value net AND RIVR's margin after
 * Stripe's 2.9% + 30¢. Dues carry no flat Connect overhead (that remains a
 * marketplace-only policy), so the gross-up runs with `connectOverheadCents: 0`.
 */
export function computeGroupSubscriptionChargePricing(
  planAmountCentsValue: number,
): GroupSubscriptionChargePricing {
  const fees = calculateCheckoutFees(planAmountCentsValue, {
    platformFeeBps: GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT * 100,
    connectOverheadCents: 0,
  });
  return chargePricingFromBuyerTotal(planAmountCentsValue, fees.buyerTotalCents);
}

/**
 * Derives the charge pricing from a KNOWN buyer total (e.g. an admin-configured
 * Stripe price that already carries the gross-up). The application fee is
 * everything above the plan's face value.
 */
export function chargePricingFromBuyerTotal(
  planAmountCentsValue: number,
  buyerTotalCents: number,
): GroupSubscriptionChargePricing {
  const applicationFeeCents = Math.max(0, buyerTotalCents - planAmountCentsValue);
  const applicationFeePercent =
    buyerTotalCents > 0
      ? Math.round((applicationFeeCents / buyerTotalCents) * 100 * 100) / 100
      : 0;
  return {
    planAmountCents: planAmountCentsValue,
    buyerTotalCents,
    applicationFeeCents,
    applicationFeePercent,
  };
}
