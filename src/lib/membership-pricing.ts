/**
 * The membership "Connect settlement fee" line — recovers Stripe's ~$2/month
 * active connected-account cost ONCE, on the subscription that provisions the
 * account (Cameron, 2026-07-30: recovered here ONLY; the per-purchase
 * overhead in checkout-fees.ts is gone). GROSSED UP so RIVR nets the full
 * $2.00/mo ($24.00/yr) after Stripe's 2.9% card cut on these cents:
 * ceil(200 / 0.971) = 206; ceil(2400 / 0.971) = 2472.
 */
export const MEMBERSHIP_CONNECT_SURCHARGE_CENTS = {
  monthly: 206,
  yearly: 2472,
} as const;

export function getMembershipConnectSurchargeCents(
  billingPeriod: "monthly" | "yearly",
): number {
  return MEMBERSHIP_CONNECT_SURCHARGE_CENTS[billingPeriod];
}

export function getMembershipConnectSurchargeDollars(
  billingPeriod: "monthly" | "yearly",
): number {
  return getMembershipConnectSurchargeCents(billingPeriod) / 100;
}
