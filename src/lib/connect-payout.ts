/**
 * Real-money payout leg for job/project settlement (Stripe Connect Transfer).
 *
 * The internal ledger (`transferP2P`) is the SOURCE OF TRUTH for who-owes-whom;
 * this module adds the optional real-money hop on top: after a payout is
 * recorded internally, move actual funds from the PLATFORM balance into the
 * payee's connected account via a Stripe `Transfer`. The payee can then cash out
 * to their bank with the existing `requestPayoutAction` → `createPayout` rail.
 *
 * This is the code the `sovereign-payout-connect-bridge` design doc scoped. In
 * the current sandbox every instance shares ONE Stripe test platform key, so the
 * transfer is initiated locally (no federation round-trip); the funding model is
 * "platform holds pooled real revenue, internal ledger apportions it".
 *
 * BEST-EFFORT: a Stripe failure NEVER breaks the internal payout — the caller
 * records the returned status on the receipt and moves on. Gated behind
 * `STRIPE_CONNECT_PAYOUTS_ENABLED` (off by default; real money moves only when
 * an operator turns it on with a TEST key).
 */
import {
  createTransfer,
  getConnectPayoutReadiness,
  getPlatformAvailableCents,
} from '@/lib/stripe-connect';
import { ensureConnectAccountForAgent } from '@/lib/connect-account';

/** Verdict of a connect-payout attempt, recorded on the payout receipt. */
export type ConnectPayoutStatus =
  | 'awaiting_attestation' // job marked done; a group admin must attest to release the real payout
  | 'paid' // a real Stripe transfer settled to the payee's connected account
  | 'disabled' // the STRIPE_CONNECT_PAYOUTS_ENABLED flag is off
  | 'needs_onboarding' // payee has a connected account but it can't receive transfers yet
  | 'insufficient_funds' // the platform balance can't cover the transfer
  | 'error'; // Stripe rejected the transfer (message captured)

/** Receipt payout status set at mark-done, before an admin attests the payout. */
export const CONNECT_PAYOUT_AWAITING_ATTESTATION: ConnectPayoutStatus = 'awaiting_attestation';

export interface ConnectPayoutResult {
  status: ConnectPayoutStatus;
  /** The payee's connected account id, when resolved. */
  connectAccountId?: string;
  /** The Stripe transfer id (`tr_...`) when `status === 'paid'`. */
  transferId?: string;
  /** Human-readable detail for `needs_onboarding` / `error`. */
  detail?: string;
}

/** True when the operator has enabled real Connect payouts (TEST key expected). */
export function isConnectPayoutsEnabled(): boolean {
  return process.env.STRIPE_CONNECT_PAYOUTS_ENABLED === 'true';
}

export interface SettleConnectPayoutInput {
  /** The agent being paid (their settlement wallet holds the connected account). */
  payeeAgentId: string;
  /** Amount to transfer, in cents (matches the internal ledger payout). */
  amountCents: number;
  /** Dedupe key for retries of the SAME payout — pass the receipt/edge id. */
  idempotencyKey: string;
  /** Metadata stamped on the Stripe transfer (jobId/projectId/payerGroupId, …). */
  metadata?: Record<string, string>;
}

/**
 * Settle the real-money leg of a payout. Ensures the payee has a connected
 * account, checks it can receive transfers and that the platform has funds,
 * then creates a Stripe `Transfer`. Returns a verdict; never throws.
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

  try {
    // 1. Resolve/create the payee's connected account (idempotent).
    const { connectAccountId } = await ensureConnectAccountForAgent(input.payeeAgentId);

    // 2. Gate on payout-readiness — an un-onboarded account can't receive transfers.
    const readiness = await getConnectPayoutReadiness(connectAccountId);
    if (!readiness.transfersActive) {
      return {
        status: 'needs_onboarding',
        connectAccountId,
        detail: 'Connected account has not completed onboarding (transfers capability inactive).',
      };
    }

    // 3. Gate on platform funds — a transfer beyond the available balance fails.
    const availableCents = await getPlatformAvailableCents();
    if (availableCents < input.amountCents) {
      return {
        status: 'insufficient_funds',
        connectAccountId,
        detail: `Platform available balance ${availableCents}¢ < payout ${input.amountCents}¢.`,
      };
    }

    // 4. Move real money: platform balance -> payee connected account.
    const transfer = await createTransfer(connectAccountId, input.amountCents, {
      idempotencyKey: `connect-payout:${input.idempotencyKey}`,
      metadata: {
        payeeAgentId: input.payeeAgentId,
        ...(input.metadata ?? {}),
      },
    });

    return { status: 'paid', connectAccountId, transferId: transfer.id };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
