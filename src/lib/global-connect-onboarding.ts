/**
 * @module lib/global-connect-onboarding
 *
 * Asks GLOBAL to provision the seller's connected account and mint a hosted
 * onboarding link. Global holds every connected account in the ecosystem, so
 * this instance cannot create one.
 *
 * Sibling of `connect-payout.ts` and `global-refund.ts`, and shaped the same:
 * dedicated Global peer secret, bounded timeout, verdict instead of a throw.
 */

import { getGlobalUrl } from '@/lib/federation/global-url';

export type GlobalOnboardingStatus =
  | 'ok'
  | 'disabled'
  | 'not-authorized'
  | 'invalid'
  | 'error';

export interface GlobalOnboardingResult {
  status: GlobalOnboardingStatus;
  /** Stripe hosted-onboarding URL to redirect the seller to. */
  url?: string;
  connectAccountId?: string;
  created?: boolean;
  detail?: string;
}

export interface RequestGlobalOnboardingInput {
  sellerAgentId: string;
  /**
   * Two-letter bank country. Immutable once the Stripe account exists, so it
   * must come from an explicit seller choice — never a default.
   */
  accountCountry: string;
  /** Absolute https URL on THIS instance for a completed onboarding. */
  returnUrl: string;
  /** Absolute https URL on THIS instance for an expired/invalid link. */
  refreshUrl: string;
}

const GLOBAL_ONBOARDING_PATH = '/api/federation/connect/onboarding';
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_BAD_REQUEST = 400;

/** True only when Global mediation and its onboarding lane are both enabled. */
export function isGlobalConnectOnboardingEnabled(): boolean {
  return (
    process.env.GLOBAL_PAYMENTS_ENABLED === 'true' &&
    process.env.GLOBAL_CONNECT_ONBOARDING_ENABLED === 'true'
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
 * Request the seller's onboarding link from Global.
 *
 * Returns a verdict; never throws, so a Global outage cannot break the settings
 * page. Global's account provisioning is idempotent, so a retry after an
 * ambiguous failure reuses the existing account rather than creating a second.
 */
export async function requestGlobalConnectOnboarding(
  input: RequestGlobalOnboardingInput,
): Promise<GlobalOnboardingResult> {
  if (!isGlobalConnectOnboardingEnabled()) {
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

  const country = input.accountCountry?.trim().toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    return { status: 'invalid', detail: 'A two-letter bank country is required.' };
  }

  try {
    const response = await fetch(getGlobalUrl(GLOBAL_ONBOARDING_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        sellerAgentId: input.sellerAgentId,
        accountCountry: country,
        returnUrl: input.returnUrl,
        refreshUrl: input.refreshUrl,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = `global onboarding endpoint returned ${response.status}`;
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
      connectAccountId?: string;
      created?: boolean;
    };

    if (body.status === 'ok' && typeof body.url === 'string' && body.url) {
      return {
        status: 'ok',
        url: body.url,
        connectAccountId: body.connectAccountId,
        created: body.created,
      };
    }
    // Anything else is ambiguous; never report onboarding as ready without a URL.
    return { status: 'error', detail: `Unexpected response status: ${body.status}` };
  } catch (error) {
    return {
      status: 'error',
      detail:
        error instanceof Error ? error.message : 'Global onboarding request failed',
    };
  }
}
