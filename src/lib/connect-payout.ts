/**
 * Real-money payout leg — sovereign CLIENT to GLOBAL's Connect authority.
 *
 * GLOBAL holds all Connect accounts. This sovereign instance does NOT transfer
 * money itself; it records the internal-ledger obligation (transferP2P, the
 * source of truth) and, on admin attestation, asks GLOBAL to make the real
 * Stripe Transfer via the peer-authed `/api/federation/connect/payout` endpoint.
 * Global resolves the payee's connected account (held on its platform) and
 * settles; we record the returned verdict on the payout receipt.
 *
 * BEST-EFFORT: never throws; a failed/unreachable global returns a verdict the
 * caller records. Gated behind both the sovereign Global-payments switch and
 * the payout-specific switch.
 */
import { getGlobalUrl } from '@/lib/federation/global-url';

/** Verdict of a connect-payout attempt, recorded on the payout receipt. */
export type ConnectPayoutStatus =
  | 'awaiting_attestation' // job marked done; a group admin must attest to release the real payout
  | 'scheduled' // attested, parked until the org's payday (lib/job-payout-release.ts)
  | 'paid' // global settled a real Stripe transfer to the payee's connected account
  | 'disabled' // a required Global/payout feature flag is off
  | 'needs_onboarding' // payee has a connected account on global but it can't receive transfers yet
  | 'insufficient_funds' // global's platform balance can't cover the transfer
  | 'error'; // global rejected/unreachable (message captured)

/** Receipt payout status set at mark-done, before an admin attests the payout. */
export const CONNECT_PAYOUT_AWAITING_ATTESTATION: ConnectPayoutStatus = 'awaiting_attestation';

export interface ConnectPayoutResult {
  status: ConnectPayoutStatus;
  connectAccountId?: string;
  transferId?: string;
  detail?: string;
}

export interface SettleConnectPayoutInput {
  /** The agent being paid (their connected account is resolved on global). */
  payeeAgentId: string;
  amountCents: number;
  /** Dedupe key for retries of the SAME payout — the receipt/edge id. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/** Path of the global Connect payout authority endpoint. */
const GLOBAL_PAYOUT_PATH = '/api/federation/connect/payout';
const REQUEST_TIMEOUT_MS = 15_000;
const PAYOUT_RESPONSE_STATUSES = new Set<ConnectPayoutStatus>([
  'awaiting_attestation',
  'paid',
  'disabled',
  'needs_onboarding',
  'insufficient_funds',
  'error',
]);

/** True only when Global mediation and its payout lane are explicitly enabled. */
export function isConnectPayoutsEnabled(): boolean {
  return (
    process.env.GLOBAL_PAYMENTS_ENABLED === 'true' &&
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED === 'true'
  );
}

/**
 * Peer-auth headers for the sovereign→global call. Money movement requires the
 * dedicated Global peer secret; the broad node-admin credential is not accepted
 * as a fallback.
 */
function buildPeerAuthHeaders(): Record<string, string> | null {
  const localSlug = process.env.INSTANCE_SLUG?.trim();
  const peerSecret = process.env.FEDERATION_PEER_SECRET_GLOBAL?.trim();
  if (localSlug && peerSecret) {
    return { 'x-peer-slug': localSlug, 'x-peer-secret': peerSecret };
  }
  return null;
}

/**
 * Ask GLOBAL to settle the real-money leg for a payout. Records the internal
 * ledger stays elsewhere; this only requests the real transfer. Returns a
 * verdict; never throws.
 */
export async function settleConnectPayout(
  input: SettleConnectPayoutInput,
): Promise<ConnectPayoutResult> {
  if (!isConnectPayoutsEnabled()) {
    return { status: 'disabled' };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { status: 'error', detail: 'Non-positive payout amount.' };
  }

  const authHeaders = buildPeerAuthHeaders();
  if (!authHeaders) {
    return {
      status: 'error',
      detail: 'No dedicated Global federation peer credential configured (INSTANCE_SLUG / FEDERATION_PEER_SECRET_GLOBAL).',
    };
  }

  try {
    const response = await fetch(getGlobalUrl(GLOBAL_PAYOUT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        payeeAgentId: input.payeeAgentId,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = `global payout endpoint returned ${response.status}`;
      try {
        const err = (await response.json()) as { error?: string };
        if (err?.error) detail = `global: ${err.error}`;
      } catch {
        // non-JSON error body — keep the status-code detail
      }
      return { status: 'error', detail };
    }

    const data = (await response.json()) as ConnectPayoutResult;
    if (
      !data ||
      typeof data.status !== 'string' ||
      !PAYOUT_RESPONSE_STATUSES.has(data.status as ConnectPayoutStatus)
    ) {
      return { status: 'error', detail: 'Malformed response from global payout endpoint.' };
    }
    if (
      data.status === 'paid' &&
      (typeof data.transferId !== 'string' || data.transferId.length === 0)
    ) {
      return {
        status: 'error',
        detail: 'Global reported a paid payout without a settlement reference.',
      };
    }
    return data;
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
