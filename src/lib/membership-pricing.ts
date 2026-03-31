export const MEMBERSHIP_CONNECT_SURCHARGE_CENTS = {
  monthly: 200,
  yearly: 2400,
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
