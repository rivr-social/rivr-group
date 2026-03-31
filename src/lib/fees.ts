/**
 * Legacy checkout fee calculator used for backward-compatible pricing.
 *
 * Purpose:
 * Reproduces the historical ONE-backend fee pipeline exactly so existing
 * totals remain consistent after migration.
 *
 * Key exports:
 * `LegacyFeeBreakdown` and `calculateLegacyCheckoutFeesCents`.
 *
 * Dependencies:
 * None (deterministic math only).
 */

/**
 * Fee output shape in cents for each fee component and final total.
 */
export type LegacyFeeBreakdown = {
  subtotalCents: number;
  platformFeeCents: number;
  salesTaxCents: number;
  paymentFeeCents: number;
  totalCents: number;
};

/** Flat platform fee in dollars added to each non-zero order. */
const PLATFORM_FEE_FIXED = 1.44;
/** Platform fee rate applied to subtotal (3.3%). */
const PLATFORM_FEE_PERCENTAGE = 0.033;
/** Tax rate applied after platform fee is included. */
const SALES_TAX_RATE = 0.0905;
/** Flat payment processing fee in dollars. */
const PAYMENT_FEE_FIXED = 0.4;
/** Payment processing fee rate applied after tax (4%). */
const PAYMENT_FEE_PERCENTAGE = 0.04;

/**
 * Calculates legacy fee components and total charge for a checkout subtotal.
 *
 * @param subtotalCents Subtotal before fees/tax, in integer cents.
 * @returns A full fee breakdown in cents including the rounded total.
 * @throws {Error} When `subtotalCents` is negative or not an integer.
 * @example
 * ```ts
 * const fees = calculateLegacyCheckoutFeesCents(10_00);
 * // => { subtotalCents: 1000, platformFeeCents: ..., totalCents: ... }
 * ```
 */
export function calculateLegacyCheckoutFeesCents(subtotalCents: number): LegacyFeeBreakdown {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error("subtotalCents must be a non-negative integer");
  }

  // Preserve legacy semantics for free orders: all derived amounts are zero.
  if (subtotalCents === 0) {
    return {
      subtotalCents,
      platformFeeCents: 0,
      salesTaxCents: 0,
      paymentFeeCents: 0,
      totalCents: 0,
    };
  }

  const basePrice = subtotalCents / 100;
  const platformFee = basePrice * PLATFORM_FEE_PERCENTAGE + PLATFORM_FEE_FIXED;
  const totalAfterPlatformFee = basePrice + platformFee;
  const salesTax = totalAfterPlatformFee * SALES_TAX_RATE;
  const totalAfterSalesTax = totalAfterPlatformFee + salesTax;
  const paymentFee = totalAfterSalesTax * PAYMENT_FEE_PERCENTAGE + PAYMENT_FEE_FIXED;
  const total = basePrice + platformFee + salesTax + paymentFee;

  // Round each component independently to match the legacy backend contract.
  return {
    subtotalCents,
    platformFeeCents: Math.round(platformFee * 100),
    salesTaxCents: Math.round(salesTax * 100),
    paymentFeeCents: Math.round(paymentFee * 100),
    totalCents: Math.round(total * 100),
  };
}
