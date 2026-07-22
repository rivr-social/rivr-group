/**
 * Offering / event-ticket fee calculator ("legacy" breakdown shape).
 *
 * Purpose:
 * Keeps the historical breakdown SHAPE (`LegacyFeeBreakdown` field names) that
 * callers/UI/webhook metadata depend on, while the PRICING now delegates to the
 * single unified engine (`calculateCheckoutFees`) — RIVR 3.3% + $1.49 + Connect
 * overhead, grossed up so the payer separately covers Stripe's 2.9% + 30¢. The
 * old per-surface pipeline (platform 3.3% + $1.44, flat 9.05% "sales tax", 4% +
 * 40¢ payment leg) was RETIRED 2026-07-20 so offerings/tickets price identically
 * to marketplace/dues/crypto.
 *
 * Breakdown mapping: `paymentFeeCents` = Stripe's exact processing cost (2.9% +
 * 30¢), `platformFeeCents` = everything above subtotal + Stripe (RIVR's cut),
 * and `salesTaxCents` = 0 (retired — real sales tax, when needed, is Stripe Tax
 * remitted properly, not a flat rate kept as revenue).
 *
 * Key exports: `LegacyFeeBreakdown`, `calculateLegacyCheckoutFeesCents`,
 * `calculateOfferingDestinationCharge`.
 */
import { calculateCheckoutFees, estimateStripeProcessingFeeCents } from "@/lib/checkout-fees";

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

// The legacy per-surface fee constants (platform 3.3%+$1.44, 9.05% sales tax,
// 4%+40¢ payment leg) were retired 2026-07-20 — offerings/tickets now inherit
// the single unified margin from checkout-fees.ts. The margin/Stripe knobs live
// there (MARKETPLACE_FEE_BPS, PLATFORM_MARGIN_FIXED_CENTS, the Stripe constants).

/**
 * Calculates the fee components and total charge for a checkout subtotal.
 *
 * Buyer total = subtotal + the UNIFIED RIVR margin (3.3% + $1.49 + Connect
 * overhead), grossed up so the payer separately covers Stripe's 2.9% + 30¢.
 * No sales tax. The reported breakdown splits the total honestly:
 * `paymentFeeCents` = Stripe's exact cost, `platformFeeCents` = RIVR's cut,
 * `salesTaxCents` = 0 (retired). Delegates to `calculateCheckoutFees` so
 * offerings/tickets price identically to marketplace/dues/crypto.
 *
 * @param subtotalCents Subtotal before fees/tax, in integer cents.
 * @returns A full fee breakdown in cents including the charged total.
 * @throws {Error} When `subtotalCents` is negative or not an integer.
 * @example
 * ```ts
 * const fees = calculateLegacyCheckoutFeesCents(10_00);
 * // => totalCents identical to the historical pipeline for the same subtotal
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

  // UNIFIED MARGIN (2026-07-20): offerings + tickets now use the SAME model as
  // marketplace/dues/crypto — RIVR's 3.3% + $1.49 + Connect overhead, grossed up
  // so the payer separately covers Stripe's 2.9% + 30¢. The old base-fee +
  // payment-leg-spread + flat 9.05% "sales tax" are retired (the tax was a
  // Boulder rate charged to everyone and kept as revenue — dropped; real sales
  // tax, if ever needed, is Stripe Tax remitted properly). Same breakdown shape
  // for callers/UI: `salesTaxCents` is now always 0.
  const fees = calculateCheckoutFees(subtotalCents);
  const totalCents = fees.buyerTotalCents;
  const paymentFeeCents = estimateStripeProcessingFeeCents(totalCents);
  const salesTaxCents = 0;
  // Everything above the seller's subtotal + Stripe's cost is RIVR's cut
  // (3.3% + $1.49 + Connect overhead) — the invariant the callers rely on.
  const platformFeeCents = totalCents - subtotalCents - salesTaxCents - paymentFeeCents;

  return {
    subtotalCents,
    platformFeeCents,
    salesTaxCents,
    paymentFeeCents,
    totalCents,
  };
}

/**
 * Destination-charge breakdown for a Connect-settled offering purchase.
 *
 * On a Stripe destination charge the seller's connected account nets
 * `amount − application_fee_amount`. The platform must therefore retain
 * EVERYTHING the buyer pays on top of the seller's subtotal — platform fee,
 * sales tax, and processing surcharge — as the application fee; otherwise the
 * buyer-paid tax + processing land in the seller's account (a tax-remittance
 * leak and per-sale margin loss). This mirrors a checkout fee split where
 * `applicationFee = buyerTotal − sellerPrice`.
 */
export type OfferingDestinationCharge = {
  /** Full legacy fee breakdown for transparency / metadata. */
  breakdown: LegacyFeeBreakdown;
  /** Amount the buyer is charged = the Stripe PaymentIntent `amount`. */
  totalCents: number;
  /** Stripe `application_fee_amount` the platform retains (fee + tax + processing). */
  applicationFeeCents: number;
  /** What the seller's connected account nets after the application fee. */
  sellerNetCents: number;
};

/**
 * Computes the destination-charge amounts for an offering purchase so the
 * seller's connected account nets exactly the subtotal and the platform
 * captures the full surcharge.
 *
 * @param subtotalCents Seller's listed price before fees/tax, in integer cents.
 * @returns Charge amounts: total (buyer), application fee (platform), seller net.
 * @throws {Error} When `subtotalCents` is negative or not an integer.
 */
export function calculateOfferingDestinationCharge(
  subtotalCents: number,
): OfferingDestinationCharge {
  const breakdown = calculateLegacyCheckoutFeesCents(subtotalCents);
  const applicationFeeCents = breakdown.totalCents - breakdown.subtotalCents;
  return {
    breakdown,
    totalCents: breakdown.totalCents,
    applicationFeeCents,
    sellerNetCents: breakdown.totalCents - applicationFeeCents,
  };
}
