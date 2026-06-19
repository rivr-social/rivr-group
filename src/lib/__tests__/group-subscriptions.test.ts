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
