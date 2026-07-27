/**
 * @module lib/global-checkout
 *
 * Asks GLOBAL to create the Stripe Checkout Session for a sale that
 * originates here. Global is the only Stripe platform in the ecosystem —
 * sovereign instances hold Connect accounts, not platform credentials — so
 * local checkout creation retires in favor of this client.
 *
 * Sibling of `global-connect-onboarding.ts` / `global-refund.ts` and shaped
 * the same: dedicated Global peer secret, bounded timeout, verdict instead of
 * a throw. The full settlement payload is recorded locally as a checkout
 * obligation BEFORE calling this, so the settlement receiver can settle from
 * this instance's own record rather than trusting the notice body.
 */

import { getGlobalUrl } from '@/lib/federation/global-url';

export type GlobalCheckoutStatus =
  | 'ok'
  | 'disabled'
  | 'not-authorized'
  | 'invalid'
  | 'error';

export interface GlobalCheckoutResult {
  status: GlobalCheckoutStatus;
  /** Stripe-hosted checkout URL to redirect the buyer to. */
  url?: string;
  sessionId?: string;
  detail?: string;
}

export interface GlobalCheckoutLineItem {
  name: string;
  /** Unit amount in cents; already fee-inclusive per this instance's pricing. */
  amountCents: number;
  quantity: number;
  /** Stripe product tax code; Global falls back to its default when absent. */
  taxCode?: string;
}

export interface RequestGlobalCheckoutInput {
  /** The locally recorded obligation id; Global's idempotency key. */
  obligationId: string;
  lineItems: GlobalCheckoutLineItem[];
  /** Absolute https URL on THIS instance for a completed purchase. */
  successUrl: string;
  /** Absolute https URL on THIS instance for an abandoned purchase. */
  cancelUrl: string;
  buyerEmail?: string;
}

const GLOBAL_CHECKOUT_PATH = '/api/federation/stripe/checkout';
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_BAD_REQUEST = 400;

/** True only when Global mediation and its checkout lane are both enabled. */
export function isGlobalCheckoutEnabled(): boolean {
  return (
    process.env.GLOBAL_PAYMENTS_ENABLED === 'true' &&
    process.env.GLOBAL_CHECKOUT_ENABLED === 'true'
  );
}

function buildPeerAuthHeaders(): Record<string, string> | null {
  const localSlug = process.env.INSTANCE_SLUG?.trim();
  const peerSecret = process.env.FEDERATION_PEER_SECRET_GLOBAL?.trim();
  if (localSlug && peerSecret) {
    return { 'x-peer-slug': localSlug, 'x-peer-secret': peerSecret };
  }
  return null;
}

/**
 * Requests a mediated Checkout Session from Global.
 *
 * The sale's money settles on Global's platform ("platform_capital"), and this
 * instance credits its own ledger when the settlement notice arrives. Returns
 * a verdict; never throws. Callers must NOT fall back to local capture on an
 * error verdict — with mediation enabled, charging on a sovereign platform is
 * exactly the state this lane exists to end.
 */
export async function requestGlobalCheckout(
  input: RequestGlobalCheckoutInput,
): Promise<GlobalCheckoutResult> {
  if (!isGlobalCheckoutEnabled()) {
    return { status: 'disabled' };
  }

  const authHeaders = buildPeerAuthHeaders();
  if (!authHeaders) {
    return {
      status: 'error',
      detail:
        'No dedicated Global federation peer credential configured (INSTANCE_SLUG / FEDERATION_PEER_SECRET_GLOBAL).',
    };
  }

  try {
    const response = await fetch(getGlobalUrl(GLOBAL_CHECKOUT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        obligationId: input.obligationId,
        lineItems: input.lineItems,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        settlementModel: 'platform_capital',
        ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = `global checkout endpoint returned ${response.status}`;
      try {
        const errorBody = (await response.json()) as { error?: string };
        if (errorBody?.error) detail = errorBody.error;
      } catch {
        // Keep the status-code detail when the body is not JSON.
      }
      if (
        response.status === STATUS_UNAUTHORIZED ||
        response.status === STATUS_FORBIDDEN
      ) {
        return { status: 'not-authorized', detail };
      }
      if (response.status === STATUS_BAD_REQUEST) {
        return { status: 'invalid', detail };
      }
      return { status: 'error', detail };
    }

    const body = (await response.json()) as {
      status?: string;
      url?: string;
      sessionId?: string;
    };

    if (body.status === 'ok' && typeof body.url === 'string' && body.url) {
      return { status: 'ok', url: body.url, sessionId: body.sessionId };
    }
    // Anything else is ambiguous; never send a buyer to a URL we do not have.
    return { status: 'error', detail: `Unexpected response status: ${body.status}` };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'Global checkout request failed',
    };
  }
}
