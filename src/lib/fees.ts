/**
 * Offering / event-ticket fee calculator ("legacy" breakdown shape).
 *
 * Purpose:
 * Preserves the historical breakdown contract (platform fee + sales tax +
 * payment fee on top of the seller's subtotal) while routing the
 * payment-processing leg through the CANONICAL gross-up engine
 * (`calculateCheckoutFees`), so Stripe's rate lives in exactly one adjustable
 * place (2026-07-11 consolidation, Cameron-approved). The old standalone
 * 4% + 40¢ approximation over-collected ~1.1% + 10¢ per order; the engine
 * recovers exactly Stripe's 2.9% + 30¢ (adjust STRIPE_CARD_PERCENT_BPS /
 * STRIPE_CARD_FIXED_CENTS in checkout-fees.ts if Stripe's pricing changes).
 *
 * Key exports:
 * `LegacyFeeBreakdown` and `calculateLegacyCheckoutFeesCents` (same shape and
 * field names as before — `paymentFeeCents` is now the exact processing
 * gross-up instead of the 4% + 40¢ approximation) and
 * `calculateOfferingDestinationCharge`.
 */
import { calculateCheckoutFees } from "@/lib/checkout-fees";

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
/** Basis-point divisor. */
const BPS_DIVISOR = 10_000;

/**
 * Calculates the fee components and total charge for a checkout subtotal.
 *
 * The platform margin (3.3% + $1.44) and sales tax (9.05% of subtotal +
 * platform fee) are policy layers computed here; the processing leg is the
 * canonical engine's exact gross-up over (subtotal + margin + tax), so after
 * Stripe's cut the seller's subtotal, the platform margin, AND the tax
 * remittance all survive intact — the payer covers processing, and the
 * platform can never net negative on this surface.
 *
 * @param subtotalCents Subtotal before fees/tax, in integer cents.
 * @returns A full fee breakdown in cents including the charged total.
 * @throws {Error} When `subtotalCents` is negative or not an integer.
 * @example
 * ```ts
 * const fees = calculateLegacyCheckoutFeesCents(10_00);
 * // => { subtotalCents: 1000, platformFeeCents: 177, salesTaxCents: 107, ... }
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

  const platformFeeCents =
    Math.round((subtotalCents * PLATFORM_FEE_BPS) / BPS_DIVISOR) + PLATFORM_FEE_FIXED_CENTS;
  const salesTaxCents = Math.round(
    ((subtotalCents + platformFeeCents) * SALES_TAX_BPS) / BPS_DIVISOR,
  );

  // Exact processing gross-up over everything the payer owes before Stripe:
  // the engine call carries zero margin/overhead of its own — the policy
  // layers above are this surface's margin; the engine only guarantees the
  // processing math (single source of truth for Stripe's rate).
  const preProcessingCents = subtotalCents + platformFeeCents + salesTaxCents;
  const grossUp = calculateCheckoutFees(preProcessingCents, {
    platformFeeBps: 0,
    connectOverheadCents: 0,
  });
  const totalCents = grossUp.buyerTotalCents;
  const paymentFeeCents = totalCents - preProcessingCents;

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
