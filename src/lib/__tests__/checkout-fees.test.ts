/**
 * @fileoverview Unit tests for `calculateCheckoutFees`, focused on the referral
 * fee/split layer (group/locale/global). These lock the invariant that the
 * seller stays net-guaranteed while referral splits are grossed into the buyer
 * total and reported per-recipient for settlement.
 */
import { describe, expect, it } from "vitest";
import { calculateCheckoutFees, PLATFORM_MARGIN_FIXED_CENTS } from "@/lib/checkout-fees";
import { MARKETPLACE_FEE_BPS, BPS_DIVISOR } from "@/lib/wallet-constants";

describe("calculateCheckoutFees — base behavior", () => {
  it("keeps the seller net-guaranteed and charges the platform fee", () => {
    const fees = calculateCheckoutFees(10_000);
    expect(fees.sellerNetCents).toBe(10_000);
    expect(fees.sellerPriceCents).toBe(10_000);
    // Unified margin (2026-07-20): 3.3% of the seller price + a flat $1.49.
    expect(fees.platformFeeCents).toBe(
      Math.round((10_000 * MARKETPLACE_FEE_BPS) / BPS_DIVISOR) + PLATFORM_MARGIN_FIXED_CENTS,
    );
    expect(fees.referralSplits).toEqual([]);
    expect(fees.referralSplitTotalCents).toBe(0);
    expect(fees.buyerTotalCents).toBeGreaterThan(10_000);
  });

  it("returns an all-zero result for a zero-priced listing", () => {
    const fees = calculateCheckoutFees(0, {
      referralSplits: [{ recipientId: "g1", recipientType: "group", bps: 1000 }],
    });
    expect(fees.buyerTotalCents).toBe(0);
    expect(fees.referralSplits).toEqual([]);
    expect(fees.referralSplitTotalCents).toBe(0);
  });

  it("rejects negative or non-integer seller prices", () => {
    expect(() => calculateCheckoutFees(-1)).toThrow();
    expect(() => calculateCheckoutFees(10.5)).toThrow();
  });
});

describe("calculateCheckoutFees — referral splits", () => {
  it("computes a single group split as bps of the seller price", () => {
    const fees = calculateCheckoutFees(10_000, {
      referralSplits: [{ recipientId: "grp", recipientType: "group", bps: 500 }],
    });
    expect(fees.referralSplits).toHaveLength(1);
    expect(fees.referralSplits[0]).toMatchObject({
      recipientId: "grp",
      recipientType: "group",
      bps: 500,
      cents: 500, // 5% of 10,000
    });
    expect(fees.referralSplitTotalCents).toBe(500);
  });

  it("sums multiple recipients (group + locale + global)", () => {
    const fees = calculateCheckoutFees(20_000, {
      referralSplits: [
        { recipientId: "grp", recipientType: "group", bps: 300 },
        { recipientId: "loc", recipientType: "locale", bps: 200 },
        { recipientId: "global", recipientType: "global", bps: 100 },
      ],
    });
    expect(fees.referralSplits.map((s) => s.cents)).toEqual([600, 400, 200]);
    expect(fees.referralSplitTotalCents).toBe(1_200);
  });

  it("grosses referral splits into the buyer total on top of the base case", () => {
    const base = calculateCheckoutFees(10_000);
    const withSplit = calculateCheckoutFees(10_000, {
      referralSplits: [{ recipientId: "grp", recipientType: "group", bps: 1000 }],
    });
    expect(withSplit.buyerTotalCents).toBeGreaterThan(base.buyerTotalCents);
    // Seller still nets the same listed price regardless of referral layer.
    expect(withSplit.sellerNetCents).toBe(base.sellerNetCents);
  });

  it("drops zero-cent and non-positive-bps splits", () => {
    const fees = calculateCheckoutFees(10_000, {
      referralSplits: [
        { recipientId: "zero", recipientType: "group", bps: 0 },
        { recipientId: "neg", recipientType: "locale", bps: -100 },
        { recipientId: "tiny", recipientType: "global", bps: 1 }, // rounds to 1c at 10k
      ],
    });
    const ids = fees.referralSplits.map((s) => s.recipientId);
    expect(ids).not.toContain("zero");
    expect(ids).not.toContain("neg");
    expect(ids).toContain("tiny");
  });

  it("reconciles platform revenue: buyerTotal - seller - org - referral >= 0", () => {
    const fees = calculateCheckoutFees(15_000, {
      orgCommissionBps: 400,
      referralSplits: [
        { recipientId: "grp", recipientType: "group", bps: 500 },
        { recipientId: "loc", recipientType: "locale", bps: 250 },
      ],
    });
    const platformRevenue =
      fees.buyerTotalCents -
      fees.sellerNetCents -
      fees.orgCommissionCents -
      fees.referralSplitTotalCents;
    expect(platformRevenue).toBeGreaterThanOrEqual(0);
  });
});

describe("calculateCheckoutFees — micro-transaction overhead scaling", () => {
  it("recovers Connect overhead proportionally on small carts (the $6 case)", () => {
    // Overhead scales at min(200, 5% of price) = 30¢ on a $6 cart (vs the old
    // flat $2 → $2.86/~48%). Unified margin: 3.3% of 600 = 20¢ + $1.49 = 169¢.
    // targetNet = 169 + 30 = 199 → gross-up ceil((600+199+30)/0.971) = 854.
    const fees = calculateCheckoutFees(600);
    expect(fees.connectAccountFeeEstimateCents).toBe(30);
    expect(fees.buyerTotalCents).toBe(854);
    expect(fees.buyerPlatformFeeCents).toBe(254);
    // Seller net stays guaranteed.
    expect(fees.sellerNetCents).toBe(600);
  });

  it("caps at the flat overhead so carts ≥ $40 price exactly as before", () => {
    const fees = calculateCheckoutFees(4_000);
    expect(fees.connectAccountFeeEstimateCents).toBe(200);
    // margin 3.3% of 4000 = 132 + $1.49 = 281; + overhead 200 + stripe fixed 30
    // = 4511 → grossed at 2.9%.
    expect(fees.buyerTotalCents).toBe(Math.ceil(4_511 / (1 - 0.029)));
  });

  it("an explicit connectOverheadCents override still wins (dues pass 0)", () => {
    const fees = calculateCheckoutFees(600, { connectOverheadCents: 0 });
    expect(fees.connectAccountFeeEstimateCents).toBe(0);
  });
});
