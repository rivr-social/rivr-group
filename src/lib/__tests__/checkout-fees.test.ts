/**
 * @fileoverview Unit tests for `calculateCheckoutFees`, focused on the referral
 * fee/split layer (group/locale/global). These lock the invariant that the
 * seller stays net-guaranteed while referral splits are grossed into the buyer
 * total and reported per-recipient for settlement.
 */
import { describe, expect, it } from "vitest";
import {
  CROSS_BORDER_TRANSFER_BPS,
  calculateCheckoutFees,
  describeDepositCharge,
  grossUpForStripeCents,
  PLATFORM_MARGIN_FIXED_CENTS,
} from "@/lib/checkout-fees";
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

describe("calculateCheckoutFees — Connect overhead lives on the membership, not the cart", () => {
  it("charges NO per-purchase Connect overhead (the $6 case)", () => {
    // Stripe's ~$2/month active-account cost is recovered ONCE, on the
    // membership subscription's grossed "Connect settlement fee" line
    // (Cameron, 2026-07-30) — recovering it per purchase double-charged
    // every subscribed seller's buyers. Unified margin: 3.3% of 600 = 20¢
    // + $1.49 = 169¢ → gross-up ceil((600+169+30)/0.971) = 823.
    const fees = calculateCheckoutFees(600);
    expect(fees.connectAccountFeeEstimateCents).toBe(0);
    expect(fees.buyerTotalCents).toBe(823);
    expect(fees.buyerPlatformFeeCents).toBe(223);
    // Seller net stays guaranteed.
    expect(fees.sellerNetCents).toBe(600);
  });

  it("prices a $40 cart from margin + gross-up alone", () => {
    const fees = calculateCheckoutFees(4_000);
    expect(fees.connectAccountFeeEstimateCents).toBe(0);
    // margin 3.3% of 4000 = 132 + $1.49 = 281; + stripe fixed 30 = 4311 →
    // grossed at 2.9%.
    expect(fees.buyerTotalCents).toBe(Math.ceil(4_311 / (1 - 0.029)));
  });

  it("an explicit connectOverheadCents still wins for callers with a real per-charge overhead", () => {
    const fees = calculateCheckoutFees(600, { connectOverheadCents: 200 });
    expect(fees.connectAccountFeeEstimateCents).toBe(200);
    expect(fees.buyerTotalCents).toBeGreaterThan(calculateCheckoutFees(600).buyerTotalCents);
  });
});

describe("calculateCheckoutFees — payout corridors", () => {
  it("connect_cross_border grosses 0.25% + 25\u00a2 into the buyer total; seller nets face", () => {
    const domestic = calculateCheckoutFees(10_000);
    const xb = calculateCheckoutFees(10_000, { payoutCorridor: "connect_cross_border" });
    expect(xb.crossBorderFeeCents).toBe(
      Math.round((10_000 * CROSS_BORDER_TRANSFER_BPS) / 10_000) + 25,
    );
    expect(xb.sellerNetCents).toBe(10_000);
    expect(xb.buyerTotalCents).toBeGreaterThan(domestic.buyerTotalCents);
    expect(xb.platformFeeCents).toBe(domestic.platformFeeCents);
  });

  it("global_payouts grosses $1.50 + volume tier + FX; seller nets face", () => {
    const gp = calculateCheckoutFees(50_000, { payoutCorridor: "global_payouts" });
    // 1.25% + 1% of $500 = $11.25, + $1.50 flat = $12.75
    expect(gp.crossBorderFeeCents).toBe(1_275);
    expect(gp.sellerNetCents).toBe(50_000);
  });

  it("domestic and absent corridor carry no surcharge", () => {
    expect(calculateCheckoutFees(10_000).crossBorderFeeCents).toBe(0);
    expect(
      calculateCheckoutFees(10_000, { payoutCorridor: "domestic" }).crossBorderFeeCents,
    ).toBe(0);
  });

  it("composes with other buyer-funded components", () => {
    const fees = calculateCheckoutFees(20_000, {
      orgCommissionBps: 500,
      payoutCorridor: "connect_cross_border",
    });
    expect(fees.crossBorderFeeCents).toBe(75); // 50 (0.25%) + 25 flat
    expect(fees.orgCommissionCents).toBe(1_000);
    expect(fees.sellerNetCents).toBe(20_000);
    expect(fees.applicationFeeCents).toBe(fees.buyerTotalCents - 20_000);
  });
});

describe("describeDepositCharge — wallet top-up disclosure (PAY-36)", () => {
  it("itemizes the live $5 case exactly as the PaymentIntent is priced", () => {
    // The audit's repro: a $5.00 top-up charges 561¢ (500 credit + 61 fee).
    const charge = describeDepositCharge(500);
    expect(charge.chargeCents).toBe(561);
    expect(charge.creditCents).toBe(500);
    expect(charge.stripeFeeCoveredCents).toBe(61);
  });

  it("always agrees with the gross-up the charge is priced from", () => {
    for (const credit of [100, 500, 1_000, 2_500, 5_000, 10_000, 99_999]) {
      const charge = describeDepositCharge(credit);
      expect(charge.chargeCents).toBe(grossUpForStripeCents(credit));
      // The three figures must reconcile — this is the disclosure's whole claim.
      expect(charge.creditCents + charge.stripeFeeCoveredCents).toBe(charge.chargeCents);
    }
  });

  it("never quotes a fee below Stripe's fixed component", () => {
    // A $1.00 minimum deposit still covers the 30¢ fixed fee plus the percent.
    expect(describeDepositCharge(100).stripeFeeCoveredCents).toBeGreaterThanOrEqual(30);
  });

  it("returns an all-zero breakdown for a non-chargeable request", () => {
    for (const bad of [0, -100, 10.5, Number.NaN]) {
      expect(describeDepositCharge(bad)).toEqual({
        creditCents: 0,
        stripeFeeCoveredCents: 0,
        chargeCents: 0,
      });
    }
  });
});
