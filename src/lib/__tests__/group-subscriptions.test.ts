/**
 * @fileoverview Unit tests for the pure helpers in `@/lib/group-subscriptions`:
 * `planAmountCents` (per-period charge resolution) and `computePlatformFeeCents`
 * (RIVR's per-member platform fee). These lock the invariants the Stripe
 * checkout builder and the platform-capital settlement rail depend on.
 */
import { describe, expect, it } from "vitest";
import {
  planAmountCents,
  computePlatformFeeCents,
  computeGroupSubscriptionChargePricing,
  chargePricingFromBuyerTotal,
  GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT,
} from "@/lib/group-subscription-pricing";
import type { GroupMembershipPlan } from "@/lib/group-memberships";

function makePlan(overrides: Partial<GroupMembershipPlan> = {}): GroupMembershipPlan {
  return {
    id: "core",
    name: "Core",
    description: "",
    amountMonthlyCents: 2000,
    amountYearlyCents: 20000,
    active: true,
    perks: [],
    isDefault: true,
    ...overrides,
  };
}

describe("planAmountCents", () => {
  it("returns the monthly amount for the monthly period", () => {
    expect(planAmountCents(makePlan(), "monthly")).toBe(2000);
  });

  it("returns the yearly amount for the yearly period", () => {
    expect(planAmountCents(makePlan(), "yearly")).toBe(20000);
  });

  it("treats a null amount as free (returns null)", () => {
    expect(planAmountCents(makePlan({ amountMonthlyCents: null }), "monthly")).toBeNull();
  });

  it("treats a zero amount as free (returns null)", () => {
    expect(planAmountCents(makePlan({ amountMonthlyCents: 0 }), "monthly")).toBeNull();
  });

  it("treats a negative amount as free (returns null)", () => {
    expect(planAmountCents(makePlan({ amountYearlyCents: -5 }), "yearly")).toBeNull();
  });
});

describe("computePlatformFeeCents", () => {
  it("applies the configured percent and rounds to the nearest cent", () => {
    expect(computePlatformFeeCents(2000)).toBe(
      Math.round((2000 * GROUP_SUBSCRIPTION_PLATFORM_FEE_PERCENT) / 100),
    );
  });

  it("rounds fractional cents correctly", () => {
    // 1999 * 5% = 99.95 -> 100
    expect(computePlatformFeeCents(1999)).toBe(100);
  });

  it("never returns a negative fee", () => {
    expect(computePlatformFeeCents(0)).toBe(0);
    expect(computePlatformFeeCents(-100)).toBe(0);
  });
});

describe("computeGroupSubscriptionChargePricing", () => {
  const STRIPE_PERCENT = 0.029;
  const STRIPE_FIXED_CENTS = 30;

  function stripeFeeFor(buyerTotalCents: number): number {
    return Math.round(buyerTotalCents * STRIPE_PERCENT) + STRIPE_FIXED_CENTS;
  }

  it("grosses up $10 dues so the platform never nets negative (the −9¢ bug)", () => {
    const pricing = computeGroupSubscriptionChargePricing(1000);

    expect(pricing.planAmountCents).toBe(1000);
    expect(pricing.buyerTotalCents).toBeGreaterThan(1000);

    // The application fee must cover Stripe's processing cost on the FULL
    // buyer total plus RIVR's 5% margin on face value — this is exactly what
    // the flat 5%-of-face model violated ($0.50 fee vs ~$0.59 Stripe cost).
    const stripeFee = stripeFeeFor(pricing.buyerTotalCents);
    const platformNet = pricing.applicationFeeCents - stripeFee;
    expect(platformNet).toBeGreaterThanOrEqual(computePlatformFeeCents(1000) - 1);
  });

  it("preserves the group's full face value as its net on the connect rail", () => {
    for (const face of [500, 1000, 2500, 20000]) {
      const pricing = computeGroupSubscriptionChargePricing(face);
      // Group nets buyerTotal − applicationFee = face, by construction.
      expect(pricing.buyerTotalCents - pricing.applicationFeeCents).toBe(face);
    }
  });

  it("keeps the platform solvent across small dues amounts", () => {
    for (const face of [100, 300, 500, 999, 1500]) {
      const pricing = computeGroupSubscriptionChargePricing(face);
      const stripeFee = stripeFeeFor(pricing.buyerTotalCents);
      expect(pricing.applicationFeeCents).toBeGreaterThanOrEqual(stripeFee);
    }
  });

  it("derives an application_fee_percent within Stripe's 2-decimal precision", () => {
    const pricing = computeGroupSubscriptionChargePricing(1000);
    expect(pricing.applicationFeePercent).toBeGreaterThan(0);
    expect(pricing.applicationFeePercent).toBeLessThan(100);
    expect(Math.round(pricing.applicationFeePercent * 100)).toBeCloseTo(
      pricing.applicationFeePercent * 100,
      5,
    );

    // Applying the percent to the buyer total reproduces the fee within a cent.
    const reconstructed = Math.round(
      (pricing.buyerTotalCents * pricing.applicationFeePercent) / 100,
    );
    expect(Math.abs(reconstructed - pricing.applicationFeeCents)).toBeLessThanOrEqual(1);
  });

  it("adds no flat Connect overhead to dues (gross-up covers Stripe + 5% only)", () => {
    const face = 1000;
    const pricing = computeGroupSubscriptionChargePricing(face);
    const margin = computePlatformFeeCents(face);
    // buyerTotal = ceil((face + margin + 30) / (1 − 0.029)) — no +$2.00 term.
    const expected = Math.ceil((face + margin + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT));
    expect(pricing.buyerTotalCents).toBe(expected);
  });
});

describe("chargePricingFromBuyerTotal", () => {
  it("treats everything above face value as the application fee", () => {
    const pricing = chargePricingFromBuyerTotal(1000, 1318);
    expect(pricing.applicationFeeCents).toBe(318);
    expect(pricing.applicationFeePercent).toBeCloseTo((318 / 1318) * 100, 2);
  });

  it("clamps a below-face buyer total to a zero fee instead of going negative", () => {
    const pricing = chargePricingFromBuyerTotal(1000, 900);
    expect(pricing.applicationFeeCents).toBe(0);
    expect(pricing.applicationFeePercent).toBe(0);
  });

  it("handles a zero buyer total without dividing by zero", () => {
    const pricing = chargePricingFromBuyerTotal(0, 0);
    expect(pricing.applicationFeePercent).toBe(0);
  });
});
