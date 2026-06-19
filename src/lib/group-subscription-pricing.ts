/**
 * Pure pricing helpers for group membership subscriptions.
 *
 * Kept free of database/Stripe imports so they can be unit-tested and reused on
 * both the server (checkout builder, webhook settlement) and any client surface
 * without pulling the server-only dependency graph.
 */
import type { GroupMembershipPlan } from '@/lib/group-memberships';

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
