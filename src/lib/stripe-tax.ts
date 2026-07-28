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

/**
 * Wallet (internal-balance) purchases run no Stripe charge, so no tax can be
 * computed or remitted through Stripe. While unregistered that matches the
 * card lanes (nothing collects anywhere). Once registered, letting wallet
 * balance buy TAX-SENSITIVE items (tangible goods, in-person admissions)
 * would silently under-collect — those purchases must go through a
 * tax-computing card lane instead. Services stay wallet-payable: Colorado
 * does not generally tax services, and under-collection there is the
 * conservative failure mode already accepted on the card lanes' tax codes.
 */
export const WALLET_PURCHASE_TAXABLE_MESSAGE =
  'This item is taxable and wallet balance cannot collect sales tax — please pay by card instead.';

/** Whether a listing is tax-sensitive for the wallet-purchase guard. */
export function isTaxSensitiveListingMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return taxCodeForListingMetadata(metadata) === STRIPE_TAX_CODE_GENERAL_GOODS;
}

// ---------------------------------------------------------------------------
// Organizer-settable admission tax (Eventbrite-style)
// ---------------------------------------------------------------------------
//
// Some admission taxes fall on the ORGANIZER and are not shifted to the
// marketplace by facilitator law (Denver's 10% Facilities Development
// Admission Tax is the canonical case: the promoter owes it and it must be
// "conspicuously, indelibly and separately stated" on the ticket). Stripe Tax
// cannot compute these, so the organizer declares one per event — a name, a
// chosen percentage, and their own registration id — and RIVR renders it as
// its OWN checkout line item, computed on the ticket subtotal, settled TO THE
// ORGANIZER (never RIVR revenue; RIVR does not remit it). It is deliberately
// a plain line item — Stripe rejects line-item tax_rates alongside
// automatic_tax — and it is EXCLUDED from RIVR's platform-fee base.

/** Parsed organizer admission tax config from `event.metadata.organizerTax`. */
export interface OrganizerAdmissionTax {
  /** Shown at checkout/on receipts, e.g. "Denver FDA Tax". */
  name: string;
  /** Percent of the ticket subtotal, 0–100, up to 2 decimal places. */
  ratePercent: number;
  /** Optional: the organizer's registration/account id, kept as audit trail. */
  registrationId?: string;
}

/**
 * Reads and validates the organizer admission tax from event metadata.
 * Returns null unless enabled with a name and a sane rate. A registration id
 * is OPTIONAL (Cameron, 07-28): the tax is the organizer's own liability to
 * remit, so RIVR does not gate it on paperwork — the id is kept purely as an
 * audit convenience when provided.
 */
export function parseOrganizerAdmissionTax(
  metadata: Record<string, unknown> | null | undefined,
): OrganizerAdmissionTax | null {
  const raw = metadata?.organizerTax;
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (t.enabled !== true) return null;
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  const registrationId =
    typeof t.registrationId === 'string' ? t.registrationId.trim() : '';
  const rateRaw = typeof t.ratePercent === 'number' ? t.ratePercent : NaN;
  const ratePercent = Math.round(rateRaw * 100) / 100;
  if (!name) return null;
  if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent > 100) {
    return null;
  }
  return { name, ratePercent, ...(registrationId ? { registrationId } : {}) };
}

/** Organizer tax in cents on a ticket subtotal (round-half-up, never negative). */
export function computeOrganizerAdmissionTaxCents(
  subtotalCents: number,
  ratePercent: number,
): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  return Math.max(0, Math.round((subtotalCents * ratePercent) / 100));
}

/** Checkout line-item label, e.g. "Denver FDA Tax (10%)". */
export function organizerAdmissionTaxLabel(tax: OrganizerAdmissionTax): string {
  const rate = Number.isInteger(tax.ratePercent)
    ? String(tax.ratePercent)
    : tax.ratePercent.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${tax.name} (${rate}%)`;
}

// ---------------------------------------------------------------------------
// Tax for ticket sales — venue (performance-location) sourcing
// ---------------------------------------------------------------------------
//
// Admissions are taxed where the EVENT takes place, not where the buyer lives
// (entertainment/amusement taxes stack on top of state+local sales tax there).
// Stripe models this as a `performance` tax location attached per line item;
// the feature is a public preview behind a preview API version. See
// docs/active/marketplace-compliance-standards-research-2026-07-27.md §3.4.

/** Preview API version that carries Tax-for-events. Per-request only. */
export const STRIPE_TAX_EVENTS_API_VERSION = '2026-03-25.preview';

/**
 * Admission to Amusement, Entertainment & Recreation Venues – Participant.
 * REQUIRES a performance location on the line item and can never be the
 * account-default tax code.
 */
export const STRIPE_TAX_CODE_EVENT_ADMISSION = 'txcd_50010001';

/** Structured venue address stored at `event.metadata.venueAddress`. */
export interface VenueAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Reads and validates a structured venue address from event metadata.
 * Returns null when absent or incomplete — callers decide whether that is a
 * hard failure (paid in-person tickets) or fine (virtual events, free RSVPs).
 */
export function parseVenueAddress(
  metadata: Record<string, unknown> | null | undefined,
): VenueAddress | null {
  const raw = metadata?.venueAddress;
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const line1 = typeof a.line1 === 'string' ? a.line1.trim() : '';
  const city = typeof a.city === 'string' ? a.city.trim() : '';
  const state = typeof a.state === 'string' ? a.state.trim().toUpperCase() : '';
  const postalCode = typeof a.postalCode === 'string' ? a.postalCode.trim() : '';
  const country =
    typeof a.country === 'string' && a.country.trim()
      ? a.country.trim().toUpperCase()
      : 'US';
  if (!line1 || !city || !postalCode || !/^[A-Z]{2}$/.test(country)) return null;
  // US addresses need a state for jurisdiction resolution.
  if (country === 'US' && !state) return null;
  const line2 = typeof a.line2 === 'string' && a.line2.trim() ? a.line2.trim() : undefined;
  return { line1, ...(line2 ? { line2 } : {}), city, state, postalCode, country };
}

/**
 * Whether the event happens online — an online admission is a digital service
 * sourced to the BUYER's address (regular `automatic_tax` behavior), so it
 * neither needs nor may use a performance location.
 */
export function isVirtualEventMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const meta = metadata ?? {};
  return (
    meta.meetingKind === 'virtual-meeting' ||
    String(meta.eventType ?? '').toLowerCase() === 'online' ||
    String(meta.locationType ?? '').toLowerCase() === 'online' ||
    meta.isVirtual === true
  );
}

/** Stable cache key for a venue address → performance tax location. */
export function performanceLocationCacheKey(address: VenueAddress): string {
  return [
    address.line1,
    address.line2 ?? '',
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ]
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Creates (or reuses, via the caller-provided cache) a Stripe `performance`
 * tax location for a venue. The caller persists the returned id next to the
 * event (`metadata.stripeTaxLocationId` + `stripeTaxLocationKey`) so repeat
 * ticket sales for the same venue never re-create it.
 *
 * @throws When Stripe rejects the address (invalid / unsupported territory) —
 *   callers surface that to the organizer, because an uncomputable venue means
 *   the ticket cannot be taxed lawfully.
 */
export async function createPerformanceTaxLocation(
  stripe: Stripe,
  address: VenueAddress,
): Promise<string> {
  const location = (await stripe.rawRequest(
    'POST',
    '/v1/tax/locations',
    {
      type: 'performance',
      address: {
        line1: address.line1,
        ...(address.line2 ? { line2: address.line2 } : {}),
        city: address.city,
        ...(address.state ? { state: address.state } : {}),
        postal_code: address.postalCode,
        country: address.country,
      },
    },
    { apiVersion: STRIPE_TAX_EVENTS_API_VERSION },
  )) as unknown as { id?: string };
  if (!location?.id) {
    throw new Error('Stripe did not return a performance tax location id');
  }
  return location.id;
}

/**
 * Origin-side refusal for a PAID in-person mediated ticket with no venue
 * address — Global would otherwise tax the wrong jurisdiction on its books.
 */
export const MEDIATED_TICKET_VENUE_REQUIRED_MESSAGE =
  'This in-person event needs a venue address before paid tickets can be sold — ' +
  'admissions tax is calculated where the event takes place. Add the venue address ' +
  'in the event settings, then try again.';

/**
 * The `product_data.tax_details` block that sources a ticket line item to the
 * event venue. Only valid together with an event tax code and the preview API
 * version on the create call.
 */
export function ticketLineItemTaxDetails(performanceLocationId: string): {
  tax_code: string;
  performance_location: string;
} {
  return {
    tax_code: STRIPE_TAX_CODE_EVENT_ADMISSION,
    performance_location: performanceLocationId,
  };
}
