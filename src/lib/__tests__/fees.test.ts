/**
 * @fileoverview Unit tests for the legacy fee pipeline and the offering
 * destination-charge split. These lock COM-DSN-001: on a Stripe destination
 * charge the platform's `application_fee_amount` must capture the FULL buyer
 * surcharge (platform fee + sales tax + processing) so the seller's connected
 * account nets exactly the subtotal — buyer-paid tax/processing must NOT accrue
 * to the seller.
 */
import { describe, expect, it } from "vitest";
import {
  calculateLegacyCheckoutFeesCents,
  calculateOfferingDestinationCharge,
} from "@/lib/fees";
import { calculateCheckoutFees } from "@/lib/checkout-fees";

describe("calculateLegacyCheckoutFeesCents", () => {
  it("returns an all-zero breakdown for a free order", () => {
    expect(calculateLegacyCheckoutFeesCents(0)).toEqual({
      subtotalCents: 0,
      platformFeeCents: 0,
      salesTaxCents: 0,
      paymentFeeCents: 0,
      totalCents: 0,
    });
  });

  it("layers platform fee then processing onto the subtotal (no sales tax)", () => {
    const b = calculateLegacyCheckoutFeesCents(100_00);
    // total is strictly greater than the subtotal, and the components sum to the
    // charged total. Sales tax is retired (unified fee model, 2026-07-20).
    expect(b.subtotalCents).toBe(100_00);
    expect(b.platformFeeCents).toBeGreaterThan(0);
    expect(b.salesTaxCents).toBe(0);
    expect(b.paymentFeeCents).toBeGreaterThan(0);
    expect(b.totalCents).toBeGreaterThan(b.subtotalCents);
    const componentSum =
      b.subtotalCents + b.platformFeeCents + b.salesTaxCents + b.paymentFeeCents;
    // paymentFee is total-derived, so the components sum EXACTLY to the total.
    expect(componentSum).toBe(b.totalCents);
  });

  it("rejects negative or non-integer subtotals", () => {
    expect(() => calculateLegacyCheckoutFeesCents(-1)).toThrow();
    expect(() => calculateLegacyCheckoutFeesCents(10.5)).toThrow();
  });

  it("components sum EXACTLY to the total (paymentFee is total-derived)", () => {
    for (const sub of [1_00, 6_00, 10_00, 45_00, 100_00]) {
      const b = calculateLegacyCheckoutFeesCents(sub);
      expect(b.subtotalCents + b.platformFeeCents + b.salesTaxCents + b.paymentFeeCents).toBe(
        b.totalCents,
      );
    }
  });

  it("prices identically to the unified checkout engine (offerings == marketplace)", () => {
    // The legacy float pipeline (3.3%+$1.44 base + 9.05% tax + 4%+40¢ leg) was
    // retired 2026-07-20; offerings/tickets now DELEGATE to calculateCheckoutFees,
    // so the buyer total must match the unified engine exactly for every subtotal.
    for (const sub of [1_00, 6_00, 10_00, 45_00, 100_00, 1000_00]) {
      const b = calculateLegacyCheckoutFeesCents(sub);
      expect(b.totalCents).toBe(calculateCheckoutFees(sub).buyerTotalCents);
    }
  });

  it("reports Stripe's exact cost as paymentFee; the spread lands in platformFee", () => {
    for (const sub of [1_00, 6_00, 10_00, 45_00, 100_00]) {
      const b = calculateLegacyCheckoutFeesCents(sub);
      const stripeCost = Math.round(b.totalCents * 0.029) + 30;
      expect(b.paymentFeeCents).toBe(stripeCost);
      // Platform line = unified margin (3.3% + $1.49) + the gross-up spread over
      // Stripe's real cost — strictly MORE than the bare margin alone (the spread
      // is stated explicitly in platformFee instead of hiding in paymentFee).
      const baseMargin = Math.round(sub * 0.033) + 149;
      expect(b.platformFeeCents).toBeGreaterThan(baseMargin);
    }
  });
});

describe("calculateOfferingDestinationCharge — COM-DSN-001", () => {
  it("nets the seller exactly the subtotal and gives the platform the rest", () => {
    const subtotalCents = 100_00;
    const charge = calculateOfferingDestinationCharge(subtotalCents);

    // The seller's Connect account receives amount − application_fee_amount.
    // That must equal the subtotal, never subtotal + tax + processing.
    expect(charge.sellerNetCents).toBe(subtotalCents);
    expect(charge.totalCents - charge.applicationFeeCents).toBe(subtotalCents);

    // The application fee is the entire buyer surcharge: platform fee + tax +
    // processing — strictly more than the bare platform fee (the old bug
    // routed only the platform fee, leaking tax + processing to the seller).
    expect(charge.applicationFeeCents).toBe(
      charge.breakdown.totalCents - charge.breakdown.subtotalCents,
    );
    expect(charge.applicationFeeCents).toBeGreaterThan(
      charge.breakdown.platformFeeCents,
    );
    const surcharge =
      charge.breakdown.platformFeeCents +
      charge.breakdown.salesTaxCents +
      charge.breakdown.paymentFeeCents;
    expect(charge.applicationFeeCents).toBe(surcharge);
  });

  it("holds the seller-net invariant across a range of prices", () => {
    for (const subtotalCents of [1_00, 7_55, 50_00, 999_99, 1_000_00]) {
      const charge = calculateOfferingDestinationCharge(subtotalCents);
      expect(charge.sellerNetCents).toBe(subtotalCents);
      expect(charge.totalCents).toBeGreaterThan(subtotalCents);
      expect(charge.applicationFeeCents).toBe(charge.totalCents - subtotalCents);
    }
  });

  it("charges nothing for a free offering", () => {
    const charge = calculateOfferingDestinationCharge(0);
    expect(charge.totalCents).toBe(0);
    expect(charge.applicationFeeCents).toBe(0);
    expect(charge.sellerNetCents).toBe(0);
  });

  it("rejects invalid subtotals", () => {
    expect(() => calculateOfferingDestinationCharge(-5)).toThrow();
    expect(() => calculateOfferingDestinationCharge(3.14)).toThrow();
  });
});
