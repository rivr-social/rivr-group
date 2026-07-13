import { describe, it, expect } from "vitest";
import {
  computeVoucherThanksValue,
  VOUCHER_RATING_MIN,
  VOUCHER_RATING_MAX,
} from "@/lib/voucher-valuation";

/**
 * The valuation is the single source of truth shared by the VoucherBuilder UI
 * and the volunteer job-completion payout. It must exactly reproduce the
 * builder's formula: round( sqrt(skill × difficulty) × hours ).
 */
describe("computeVoucherThanksValue", () => {
  it("matches the VoucherBuilder formula for representative inputs", () => {
    // sqrt(5 × 5) × 1 = 5
    expect(computeVoucherThanksValue({ skillfulness: 5, difficulty: 5, hours: 1 })).toBe(5);
    // sqrt(100 × 100) × 2 = 200
    expect(computeVoucherThanksValue({ skillfulness: 100, difficulty: 100, hours: 2 })).toBe(200);
    // sqrt(1 × 1) × 3 = 3
    expect(computeVoucherThanksValue({ skillfulness: 1, difficulty: 1, hours: 3 })).toBe(3);
  });

  it("rounds to the nearest integer", () => {
    // sqrt(10 × 20) = 14.142… × 1 → 14
    expect(computeVoucherThanksValue({ skillfulness: 10, difficulty: 20, hours: 1 })).toBe(14);
    // sqrt(50 × 50) = 50 × 1.5 = 75
    expect(computeVoucherThanksValue({ skillfulness: 50, difficulty: 50, hours: 1.5 })).toBe(75);
    // sqrt(2 × 3) = 2.449… → rounds to 2
    expect(computeVoucherThanksValue({ skillfulness: 2, difficulty: 3, hours: 1 })).toBe(2);
  });

  it("returns 0 for non-positive or non-finite hours", () => {
    expect(computeVoucherThanksValue({ skillfulness: 100, difficulty: 100, hours: 0 })).toBe(0);
    expect(computeVoucherThanksValue({ skillfulness: 50, difficulty: 50, hours: -4 })).toBe(0);
    expect(computeVoucherThanksValue({ skillfulness: 50, difficulty: 50, hours: NaN })).toBe(0);
  });

  it("clamps ratings into the slider range", () => {
    // Below MIN clamps up to MIN; above MAX clamps down to MAX.
    expect(computeVoucherThanksValue({ skillfulness: 0, difficulty: 0, hours: 4 })).toBe(
      computeVoucherThanksValue({ skillfulness: VOUCHER_RATING_MIN, difficulty: VOUCHER_RATING_MIN, hours: 4 }),
    );
    expect(computeVoucherThanksValue({ skillfulness: 999, difficulty: 999, hours: 1 })).toBe(
      computeVoucherThanksValue({ skillfulness: VOUCHER_RATING_MAX, difficulty: VOUCHER_RATING_MAX, hours: 1 }),
    );
    // NaN ratings fall back to MIN.
    expect(computeVoucherThanksValue({ skillfulness: NaN, difficulty: NaN, hours: 2 })).toBe(2);
  });

  it("never returns a negative value", () => {
    expect(computeVoucherThanksValue({ skillfulness: 1, difficulty: 1, hours: 0 })).toBeGreaterThanOrEqual(0);
  });
});
