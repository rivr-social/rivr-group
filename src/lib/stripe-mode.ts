/**
 * @module lib/stripe-mode
 *
 * Test/live mode binding for inbound Stripe events.
 *
 * A correctly signed event whose `livemode` disagrees with this instance's keys
 * came from an endpoint pointed at the wrong instance. Processing it is silent
 * and dangerous in both directions: a test event settled here would credit real
 * group balances from play money, and a live event landing on a test instance
 * would record real member money as test data.
 *
 * This is the sovereign counterpart of global's `lib/stripe-mode.ts`. It derives
 * the mode from the secret key prefix rather than global's fail-closed
 * `validateStripeOperationalConfiguration`, because sovereign instances do not
 * carry that validation — Global is the sole Stripe platform, and local capture
 * is being retired. Deliberately NOT a manifest-shared contract file: the two
 * implementations answer the same question from different sources.
 */

/** The Stripe environment a key set or event belongs to. */
export type StripeMode = 'test' | 'live';

/** Maps Stripe's boolean `livemode` flag onto the mode vocabulary. */
export function stripeModeOfLivemode(livemode: boolean): StripeMode {
  return livemode ? 'live' : 'test';
}

/**
 * The mode of this instance's Stripe credentials, or `null` when no usable key
 * is configured. A null result means the caller cannot judge the event and must
 * not silently accept it.
 */
export function getStripeRuntimeMode(): StripeMode | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return null;
}

/**
 * Whether an inbound event belongs to the mode this instance runs in.
 *
 * Returns false when the mode cannot be determined, so an unconfigured or
 * malformed key set rejects events rather than processing them blindly.
 * Callers must ACKNOWLEDGE a rejected event (HTTP 200) without dispatching it —
 * retrying can never make a cross-mode delivery valid.
 */
export function eventMatchesRuntimeMode(livemode: boolean): boolean {
  const runtimeMode = getStripeRuntimeMode();
  if (!runtimeMode) return false;
  return stripeModeOfLivemode(livemode) === runtimeMode;
}
