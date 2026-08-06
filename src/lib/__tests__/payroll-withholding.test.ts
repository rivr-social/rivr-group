/**
 * Unit tests for the pure payroll-withholding layer: the rate clamp, the
 * gross→(withheld, net) split, the bank-leg amount resolver the two payout
 * legs agree through, and the payout-schedule normalize/due logic.
 */
import { describe, expect, it } from "vitest";
import {
  bankLegAmountCents,
  clampPayrollWithholdingBps,
  computePayrollWithholding,
  isReleaseDue,
  normalizePayoutSchedule,
  PAYROLL_RECEIPT_KEYS,
  PAYROLL_WITHHOLDING_MAX_BPS,
} from "@/lib/payroll-withholding";

describe("clampPayrollWithholdingBps", () => {
  it("clamps into [0, 5000] and rounds", () => {
    expect(clampPayrollWithholdingBps(-100)).toBe(0);
    expect(clampPayrollWithholdingBps(0)).toBe(0);
    expect(clampPayrollWithholdingBps(1234.6)).toBe(1235);
    expect(clampPayrollWithholdingBps(5000)).toBe(PAYROLL_WITHHOLDING_MAX_BPS);
    expect(clampPayrollWithholdingBps(9999)).toBe(PAYROLL_WITHHOLDING_MAX_BPS);
  });

  it("treats non-finite input as 0", () => {
    expect(clampPayrollWithholdingBps(Number.NaN)).toBe(0);
    expect(clampPayrollWithholdingBps(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("computePayrollWithholding", () => {
  it("splits so withheld + net always reconcile to gross", () => {
    for (const gross of [1, 99, 100, 12_345, 1_000_000]) {
      for (const rate of [0, 1, 750, 2200, 5000]) {
        const split = computePayrollWithholding(gross, rate);
        expect(split.withheldCents + split.netCents).toBe(gross);
        expect(split.withheldCents).toBeGreaterThanOrEqual(0);
        expect(split.netCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("applies the rate with cent rounding", () => {
    // 22% of $100.00 = $22.00
    expect(computePayrollWithholding(10_000, 2200).withheldCents).toBe(2_200);
    // 7.5% of $0.99 = 7.4¢ → 7¢
    expect(computePayrollWithholding(99, 750).withheldCents).toBe(7);
  });

  it("clamps requested rates above the ceiling to 50%", () => {
    const split = computePayrollWithholding(10_000, 9999);
    expect(split.effectiveRateBps).toBe(PAYROLL_WITHHOLDING_MAX_BPS);
    expect(split.withheldCents).toBe(5_000);
  });

  it("passes through non-positive or fractional gross unchanged", () => {
    expect(computePayrollWithholding(0, 2000).withheldCents).toBe(0);
    expect(computePayrollWithholding(-50, 2000).withheldCents).toBe(0);
  });
});

describe("bankLegAmountCents", () => {
  it("prefers the stamped payroll net over the receipt amount", () => {
    expect(
      bankLegAmountCents({
        amountCents: 10_000,
        [PAYROLL_RECEIPT_KEYS.netCents]: 7_800,
      }),
    ).toBe(7_800);
  });

  it("falls back to amountCents for unstamped (pre-feature / disabled) receipts", () => {
    expect(bankLegAmountCents({ amountCents: 10_000 })).toBe(10_000);
  });

  it("returns 0 for garbage metadata rather than paying something", () => {
    expect(bankLegAmountCents({})).toBe(0);
    expect(bankLegAmountCents({ amountCents: "100" })).toBe(0);
    expect(
      bankLegAmountCents({ amountCents: 100, [PAYROLL_RECEIPT_KEYS.netCents]: -5 }),
    ).toBe(100);
  });
});

describe("normalizePayoutSchedule", () => {
  it("defaults unknown cadences to manual", () => {
    expect(normalizePayoutSchedule(undefined)).toEqual({ cadence: "manual" });
    expect(normalizePayoutSchedule({ cadence: "yearly" })).toEqual({ cadence: "manual" });
  });

  it("clamps weekly day into [0,6] with Friday default", () => {
    expect(normalizePayoutSchedule({ cadence: "weekly" })).toEqual({
      cadence: "weekly",
      dayOfWeek: 5,
    });
    expect(normalizePayoutSchedule({ cadence: "weekly", dayOfWeek: 9 }).dayOfWeek).toBe(6);
  });

  it("clamps monthly day into [1,28] so every month qualifies", () => {
    expect(normalizePayoutSchedule({ cadence: "monthly", dayOfMonth: 31 }).dayOfMonth).toBe(28);
    expect(normalizePayoutSchedule({ cadence: "monthly", dayOfMonth: 0 }).dayOfMonth).toBe(1);
  });
});

describe("isReleaseDue", () => {
  it("manual is never due — attest itself releases", () => {
    expect(isReleaseDue({ cadence: "manual" }, new Date())).toBe(false);
  });

  it("daily is always due", () => {
    expect(isReleaseDue({ cadence: "daily" }, new Date())).toBe(true);
  });

  it("weekly matches the configured UTC weekday", () => {
    const friday = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07 is a Friday
    expect(isReleaseDue({ cadence: "weekly", dayOfWeek: 5 }, friday)).toBe(true);
    expect(isReleaseDue({ cadence: "weekly", dayOfWeek: 1 }, friday)).toBe(false);
  });

  it("monthly matches the configured UTC day of month", () => {
    const first = new Date(Date.UTC(2026, 8, 1));
    expect(isReleaseDue({ cadence: "monthly", dayOfMonth: 1 }, first)).toBe(true);
    expect(isReleaseDue({ cadence: "monthly", dayOfMonth: 15 }, first)).toBe(false);
  });
});
