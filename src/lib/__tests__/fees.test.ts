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

  it("layers platform fee, tax, then processing onto the subtotal", () => {
    const b = calculateLegacyCheckoutFeesCents(100_00);
    // total is strictly greater than each intermediate, and the components sum
    // (within rounding) to the charged total.
    expect(b.subtotalCents).toBe(100_00);
    expect(b.platformFeeCents).toBeGreaterThan(0);
    expect(b.salesTaxCents).toBeGreaterThan(0);
    expect(b.paymentFeeCents).toBeGreaterThan(0);
    expect(b.totalCents).toBeGreaterThan(b.subtotalCents);
    const componentSum =
      b.subtotalCents + b.platformFeeCents + b.salesTaxCents + b.paymentFeeCents;
    // independent per-component rounding can drift the sum by a few cents.
    expect(Math.abs(componentSum - b.totalCents)).toBeLessThanOrEqual(2);
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

  it("paymentFee covers Stripe's exact 2.9% + 30¢ on the charged total", () => {
    for (const sub of [1_00, 6_00, 10_00, 45_00, 100_00]) {
      const b = calculateLegacyCheckoutFeesCents(sub);
      const stripeCost = Math.round(b.totalCents * 0.029) + 30;
      expect(b.paymentFeeCents).toBeGreaterThanOrEqual(stripeCost - 1);
      // …and is the exact gross-up, not the old 4% + 40¢ over-collection.
      const preProcessing = b.subtotalCents + b.platformFeeCents + b.salesTaxCents;
      const oldApprox = Math.round(preProcessing * 0.04) + 40;
      expect(b.paymentFeeCents).toBeLessThan(oldApprox);
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
