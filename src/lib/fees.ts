/**
 * Offering / event-ticket fee calculator ("legacy" breakdown shape).
 *
 * Purpose:
 * Preserves the historical PRICING exactly — the buyer total and the
 * platform's take are unchanged from the legacy pipeline (platform 3.3% +
 * $1.44, tax 9.05%, payment leg 4% + 40¢; the profit model depends on the
 * spread between the payment leg and Stripe's actual cost — Cameron,
 * 2026-07-11). What changed in the consolidation is the ACCOUNTING and the
 * cost parameter: `paymentFeeCents` now reports Stripe's exact processing
 * cost (2.9% + 30¢, the single adjustable constant pair in checkout-fees.ts)
 * and the spread above it lands explicitly in `platformFeeCents` instead of
 * hiding inside the payment line. A canonical-engine gross-up FLOOR keeps the
 * surface solvent even if Stripe's pricing ever exceeds the 4% + 40¢ leg.
 *
 * Key exports:
 * `LegacyFeeBreakdown` and `calculateLegacyCheckoutFeesCents` (same shape and
 * field names as before — `paymentFeeCents` is the exact processing cost and
 * `platformFeeCents` carries the margin INCLUDING the payment-leg spread) and
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

/** Flat platform fee in cents added to each non-zero order. */
const PLATFORM_FEE_FIXED_CENTS = 144;
/** Platform fee rate applied to subtotal (3.3%), in basis points. */
const PLATFORM_FEE_BPS = 330;
/** Tax rate applied after platform fee is included, in basis points. */
const SALES_TAX_BPS = 905;
/**
 * PRICING leg charged on top of subtotal + platform fee + tax (4% + 40¢).
 * Deliberately above Stripe's actual cost — the spread is platform margin
 * (part of the profit model, NOT a rounding artifact). Adjust THESE to change
 * what buyers pay; adjust checkout-fees.ts constants when Stripe's cost moves.
 */
const PAYMENT_LEG_BPS = 400;
const PAYMENT_LEG_FIXED_CENTS = 40;
/** Basis-point divisor. */
const BPS_DIVISOR = 10_000;

/**
 * Calculates the fee components and total charge for a checkout subtotal.
 *
 * The buyer total = subtotal + platform fee (3.3% + $1.44) + tax (9.05%) +
 * payment leg (4% + 40¢) — IDENTICAL to the historical pricing. The reported
 * breakdown splits that total honestly: `paymentFeeCents` = Stripe's exact
 * cost on the charged total, `platformFeeCents` = margin + the payment-leg
 * spread. The canonical engine's gross-up acts as a solvency FLOOR on the
 * total, so the platform cannot net negative even if Stripe's pricing ever
 * exceeds the payment leg.
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

  const baseMarginCents =
    Math.round((subtotalCents * PLATFORM_FEE_BPS) / BPS_DIVISOR) + PLATFORM_FEE_FIXED_CENTS;
  const salesTaxCents = Math.round(
    ((subtotalCents + baseMarginCents) * SALES_TAX_BPS) / BPS_DIVISOR,
  );
  const preProcessingCents = subtotalCents + baseMarginCents + salesTaxCents;

  // PRICING: the historical payment leg (4% + 40¢) sets the buyer total.
  const paymentLegCents =
    Math.round((preProcessingCents * PAYMENT_LEG_BPS) / BPS_DIVISOR) + PAYMENT_LEG_FIXED_CENTS;

  // SOLVENCY FLOOR: the canonical engine's exact gross-up over the same base
  // (zero engine margin/overhead — the layers above are this surface's
  // policy). Today the payment leg exceeds it, so the floor is inert; it
  // binds only if Stripe's cost ever outgrows the pricing leg.
  const grossUpFloorCents = calculateCheckoutFees(preProcessingCents, {
    platformFeeBps: 0,
    connectOverheadCents: 0,
  }).buyerTotalCents;

  const totalCents = Math.max(preProcessingCents + paymentLegCents, grossUpFloorCents);

  // ACCOUNTING: report Stripe's exact cost as the payment fee; everything
  // above cost + tax + subtotal is platform margin (base + payment-leg
  // spread), stated explicitly instead of hiding inside the payment line.
  const paymentFeeCents = estimateStripeProcessingFeeCents(totalCents);
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
