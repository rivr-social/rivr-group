/**
 * @module lib/global-refund
 *
 * Submits a refund obligation to GLOBAL, which is the only Stripe platform in
 * the ecosystem and therefore the only instance that may create a refund.
 *
 * Sibling of `connect-payout.ts` and deliberately shaped the same way: dedicated
 * peer credential (never the broad node-admin key), bounded timeout, and a
 * verdict rather than a thrown error, so a refund request can never take down
 * the caller's action.
 *
 * This instance does NOT decide the refund. It identifies a receipt; Global
 * re-derives origin, owner, amount, and payment intent from its own projection
 * before any money moves.
 */

import { getGlobalUrl } from '@/lib/federation/global-url';

/** Verdict of a refund submission. Never thrown; always returned. */
export type GlobalRefundStatus =
  | 'refunded'
  | 'already-requested'
  | 'disabled'
  | 'not-authorized'
  | 'not-refundable'
  | 'error';

export interface GlobalRefundResult {
  status: GlobalRefundStatus;
  refundId?: string;
  amountRefundedCents?: number;
  reversedTransfer?: boolean;
  detail?: string;
}

export interface SubmitGlobalRefundInput {
  /** Receipt id, which is also the Global-side obligation key. */
  receiptId: string;
  /** The buyer, cross-checked against Global's own record of the receipt owner. */
  buyerAgentId: string;
  /** Partial refund amount; omit for a full refund. */
  amountCents?: number;
}

const GLOBAL_REFUND_PATH = '/api/federation/stripe/refund';
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_BAD_REQUEST = 400;

/** True only when Global mediation and its refund lane are both enabled. */
export function isGlobalRefundsEnabled(): boolean {
  return (
    process.env.GLOBAL_PAYMENTS_ENABLED === 'true' &&
    process.env.GLOBAL_REFUNDS_ENABLED === 'true'
  );
}

/**
 * Peer-auth headers for the sovereign to Global call. Money movement requires
 * the dedicated Global peer secret; the broad node-admin credential is
 * deliberately not accepted as a fallback.
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
 * Ask Global to execute the refund for a receipt.
 *
 * A transport or 5xx failure returns `error` WITHOUT any local state change:
 * Global may or may not have executed, and its idempotency key makes a retry
 * safe, so the caller must not record the refund as done on this outcome.
 */
export async function submitGlobalRefund(
  input: SubmitGlobalRefundInput,
): Promise<GlobalRefundResult> {
  if (!isGlobalRefundsEnabled()) {
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
    const response = await fetch(getGlobalUrl(GLOBAL_REFUND_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        receiptId: input.receiptId,
        buyerAgentId: input.buyerAgentId,
        ...(typeof input.amountCents === 'number'
          ? { amountCents: input.amountCents }
          : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = `global refund endpoint returned ${response.status}`;
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
        return { status: 'not-refundable', detail };
      }
      return { status: 'error', detail };
    }

    const body = (await response.json()) as {
      status?: string;
      refundId?: string;
      amountRefundedCents?: number;
      reversedTransfer?: boolean;
    };

    if (body.status === 'already-requested') {
      return { status: 'already-requested' };
    }
    if (body.status === 'refunded') {
      return {
        status: 'refunded',
        refundId: body.refundId,
        amountRefundedCents: body.amountRefundedCents,
        reversedTransfer: body.reversedTransfer,
      };
    }
    // An unrecognized shape is treated as ambiguous, never as success.
    return { status: 'error', detail: `Unexpected response status: ${body.status}` };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'Global refund request failed',
    };
  }
}
