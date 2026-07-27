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

// ---------------------------------------------------------------------------
// Untaxed-path tripwire
// ---------------------------------------------------------------------------

/**
 * How long an active-registration lookup is trusted before re-checking.
 * Registrations change by hand in the Stripe dashboard, so minutes are plenty.
 */
const REGISTRATION_CACHE_TTL_MS = 5 * 60_000;

let registrationCache: { activeAt: number; hasActive: boolean } | null = null;

/**
 * Whether RIVR holds any ACTIVE Stripe Tax registration.
 *
 * This is the switch that turns `automatic_tax` from inert wiring into real
 * collection. It is read from Stripe rather than a local flag so it cannot
 * drift from what the dashboard actually says.
 */
export async function hasActiveTaxRegistrations(stripe: Stripe): Promise<boolean> {
  const now = Date.now();
  if (registrationCache && now - registrationCache.activeAt < REGISTRATION_CACHE_TTL_MS) {
    return registrationCache.hasActive;
  }

  try {
    const registrations = await stripe.tax.registrations.list({ status: 'active', limit: 1 });
    const hasActive = registrations.data.length > 0;
    registrationCache = { activeAt: now, hasActive };
    return hasActive;
  } catch (error) {
    console.error('[stripe-tax] Could not read tax registrations:', error);
    // Prefer the last known answer over guessing.
    if (registrationCache) return registrationCache.hasActive;
    // With no answer at all, do not halt commerce: today there are no
    // registrations anywhere, so the truthful default is "not collecting". The
    // loud log above is the signal that this decision was made blind.
    return false;
  }
}

/** Thrown when a charge path that cannot compute tax runs while tax is live. */
export class UntaxedChargePathError extends Error {
  constructor(public readonly pathName: string) {
    super(
      `${pathName} cannot compute sales tax, but RIVR now holds an active Stripe Tax ` +
        `registration. Charging here would under-collect tax that RIVR is liable ` +
        `for as a marketplace facilitator. Wire this path to the Tax Calculation ` +
        `API before enabling it.`,
    );
    this.name = 'UntaxedChargePathError';
  }
}

/**
 * Guards a raw-PaymentIntent charge path that has NO tax calculation.
 *
 * `automatic_tax` only exists on Checkout Sessions. The destination-charge
 * paths (offering purchase, offering accept) build PaymentIntents directly and
 * would need the Tax Calculation API — which needs a buyer address they do not
 * collect. While RIVR holds no registrations that difference is invisible,
 * because nothing collects tax anywhere. The moment a registration is added,
 * Checkout starts collecting and these paths would silently keep charging
 * untaxed, and the shortfall is RIVR's to remit.
 *
 * Failing closed here converts that silent under-collection into a loud,
 * specific error at the first affected sale.
 *
 * Does NOT apply to wallet top-ups: funding stored value is not a taxable sale,
 * and tax applies at the purchase the funds are later spent on.
 *
 * @throws {UntaxedChargePathError} When an active tax registration exists.
 */
export async function assertUntaxedChargePathAllowed(
  stripe: Stripe,
  pathName: string,
): Promise<void> {
  if (await hasActiveTaxRegistrations(stripe)) {
    throw new UntaxedChargePathError(pathName);
  }
}

/** Test seam — clears the memoized registration lookup. */
export function resetTaxRegistrationCacheForTests(): void {
  registrationCache = null;
}
