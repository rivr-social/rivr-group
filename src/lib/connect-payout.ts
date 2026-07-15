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
 * caller records. Gated behind `STRIPE_CONNECT_PAYOUTS_ENABLED` (TEST posture).
 */
import { getGlobalUrl } from '@/lib/federation/global-url';

/** Verdict of a connect-payout attempt, recorded on the payout receipt. */
export type ConnectPayoutStatus =
  | 'awaiting_attestation' // job marked done; a group admin must attest to release the real payout
  | 'paid' // global settled a real Stripe transfer to the payee's connected account
  | 'disabled' // the STRIPE_CONNECT_PAYOUTS_ENABLED flag is off
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

/** True when the operator has enabled real Connect payouts (TEST key expected). */
export function isConnectPayoutsEnabled(): boolean {
  return process.env.STRIPE_CONNECT_PAYOUTS_ENABLED === 'true';
}

/**
 * Peer-auth headers for the sovereign→global call. Mirrors the federation-sync
 * cron's `resolvePeerAuthHeaders`: `x-peer-slug` identifies US (our instance
 * slug), `x-peer-secret` is the shared secret for the global peer
 * (`FEDERATION_PEER_SECRET_GLOBAL`); falls back to `x-node-admin-key`. Returns
 * null when no credential is configured (caller reports needs-config).
 */
function buildPeerAuthHeaders(): Record<string, string> | null {
  const localSlug = process.env.INSTANCE_SLUG?.trim();
  const peerSecret = process.env.FEDERATION_PEER_SECRET_GLOBAL?.trim();
  if (localSlug && peerSecret) {
    return { 'x-peer-slug': localSlug, 'x-peer-secret': peerSecret };
  }
  const adminKey = process.env.NODE_ADMIN_KEY?.trim();
  if (adminKey) {
    return { 'x-node-admin-key': adminKey };
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
      detail: 'No federation peer credential configured (FEDERATION_PEER_SECRET_GLOBAL / NODE_ADMIN_KEY).',
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
    if (!data || typeof data.status !== 'string') {
      return { status: 'error', detail: 'Malformed response from global payout endpoint.' };
    }
    return data;
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
