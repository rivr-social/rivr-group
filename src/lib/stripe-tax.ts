/**
 * Stripe Tax wiring — centralized product tax codes + Checkout-Session config.
 *
 * RIVR is a Colorado Public Benefit Limited Cooperative Association and acts as
 * a **marketplace facilitator** for its sellers. Sales tax is destination-based:
 * Stripe Tax computes it from the BUYER's address at checkout (this replaces the
 * retired flat 9.05% Boulder rate that was wrongly charged to every buyer).
 *
 * IMPORTANT — INERT UNTIL REGISTERED. Enabling `automatic_tax` collects tax ONLY
 * in jurisdictions where RIVR has an active tax registration in the Stripe
 * dashboard (Settings → Tax → Registrations). Shipping this wiring early charges
 * nobody until Cameron adds registrations, so it is safe to deploy ahead of the
 * dashboard config. See docs/active/stripe-tax-integration-plan-2026-07-20.md.
 *
 * Scope: this module covers the Checkout-Session paths (marketplace, tickets,
 * group/org dues, platform tiers). The destination-charge paths (offerings,
 * bookings — raw PaymentIntents) need the Tax Calculation API instead (P1).
 */
import type Stripe from 'stripe';

// Stripe product tax codes — https://stripe.com/docs/tax/tax-codes.
// General - Services covers RIVR's community offerings, admissions, memberships,
// and platform fees. General - Tangible Goods is available for physical goods.
export const STRIPE_TAX_CODE_GENERAL_SERVICES = 'txcd_20030000';
export const STRIPE_TAX_CODE_GENERAL_GOODS = 'txcd_99999999';

/**
 * Default product tax code applied to RIVR line items. Most RIVR listings are
 * services/community offerings; a per-listing tax category is a future
 * refinement (listings carry no tax-category field yet). Overridable per line.
 */
export const STRIPE_TAX_CODE_DEFAULT = STRIPE_TAX_CODE_GENERAL_SERVICES;

/**
 * RIVR prices are tax-EXCLUSIVE: the listed amount is what the seller/plan
 * receives, and any sales tax is added ON TOP at checkout (never carved out of
 * the seller's net). Required on `price_data` line items when automatic_tax is on.
 */
export const RIVR_TAX_BEHAVIOR = 'exclusive' as const;

/**
 * The `automatic_tax` block for a Checkout Session.
 *
 * @param platformLiable - when the charge routes to a connected account
 *   (destination charge / Connect transfer), set this so RIVR-the-facilitator is
 *   the party liable to collect + remit, matching the marketplace-facilitator
 *   posture (`liability.type = 'self'`). For plain platform charges the default
 *   already makes the platform liable, so this is only needed on Connect paths.
 */
export function buildAutomaticTax(opts?: {
  platformLiable?: boolean;
}): Stripe.Checkout.SessionCreateParams.AutomaticTax {
  return {
    enabled: true,
    ...(opts?.platformLiable ? { liability: { type: 'self' as const } } : {}),
  };
}

/**
 * Product tax code for a marketplace listing, resolved from its metadata.
 *
 * Tangible GOODS means an EXPLICIT `listingType: "product"` that is not an
 * event ticket in product clothing (`productKind`/`offeringType: "ticket"`
 * — see graph-adapters' mart reclassification). Everything else — offerings,
 * services, vouchers, tickets, and legacy listings with no listingType —
 * stays on the services code: the conservative failure mode is
 * under-collection, never a wrong charge to a buyer.
 */
export function taxCodeForListingMetadata(
  metadata: Record<string, unknown>,
): string {
  const isProduct = metadata.listingType === 'product';
  const isTicket =
    String(metadata.productKind ?? '').toLowerCase() === 'ticket' ||
    String(metadata.offeringType ?? '').toLowerCase() === 'ticket';
  return isProduct && !isTicket
    ? STRIPE_TAX_CODE_GENERAL_GOODS
    : STRIPE_TAX_CODE_DEFAULT;
}
