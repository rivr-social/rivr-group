/**
 * Wallet constants shared by wallet and payment workflows.
 *
 * Purpose:
 * Defines amount bounds, fee math helpers, validation patterns, and shared
 * transaction status literals for wallet services.
 *
 * Key exports:
 * `MIN_DEPOSIT_CENTS`, `MAX_DEPOSIT_CENTS`, `MIN_TRANSFER_CENTS`,
 * `MAX_TRANSFER_CENTS`, `MARKETPLACE_FEE_BPS`, `BPS_DIVISOR`,
 * `ETH_ADDRESS_REGEX`, and `WALLET_TX_STATUS`.
 *
 * Dependencies:
 * None (pure constant module).
 */

/** Minimum deposit amount: $1.00 */
export const MIN_DEPOSIT_CENTS = 100;

/** Maximum deposit amount: $1,000.00 */
export const MAX_DEPOSIT_CENTS = 100_000;

/** Minimum transfer amount: $0.01 */
export const MIN_TRANSFER_CENTS = 1;

/** Maximum single P2P transfer: $500.00 */
export const MAX_TRANSFER_CENTS = 50_000;

/** Unified RIVR platform margin (percentage leg) in basis points: 3.3%. Paired
 * with the flat PLATFORM_MARGIN_FIXED_CENTS ($1.49) in checkout-fees. */
export const MARKETPLACE_FEE_BPS = 330;

/** Basis-point divisor for fee calculations */
export const BPS_DIVISOR = 10_000;

/**
 * Guardrail ceiling for the SUM of all referral fee/split recipients
 * (group + locale + global), in basis points: 50%. The resolver clamps total
 * referral bps to this so a misconfigured chain of recipients can never gross
 * the buyer total past a sane bound.
 */
export const MAX_REFERRAL_SPLIT_BPS = 5_000;

/**
 * Sentinel recipientId used for the platform/global referral fee. Settlement
 * maps this to the platform treasury wallet rather than an agent settlement
 * wallet, since the "global" recipient is the platform itself.
 */
export const GLOBAL_REFERRAL_RECIPIENT_ID = 'global';

/** Regex for validating Ethereum addresses (0x + 40 hex chars) */
export const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical wallet transaction status values.
 *
 * Configuration pattern:
 * `as const` preserves literal values so callers get strict union typing.
 */
export const WALLET_TX_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REVERSED: 'reversed',
} as const;

/**
 * `metadata.failureReason` stamped on a deposit that SETTLED at Stripe but
 * could not be credited because the destination wallet is frozen (audit W-07).
 *
 * The payer's money is captured and owed back, so the row is the reconciliation
 * anchor an operator refunds against:
 * `metadata->>'failureReason' = 'wallet_frozen' AND metadata->>'requiresRefund' = 'true'`.
 */
export const WALLET_DEPOSIT_FAILURE_WALLET_FROZEN = 'wallet_frozen';

/** The reconciliation stamp written on a stranded (captured, uncredited) deposit. */
export interface StrandedDepositStamp {
  failureReason: typeof WALLET_DEPOSIT_FAILURE_WALLET_FROZEN;
  /** Captured amount owed back to the payer, in integer cents. */
  strandedAmountCents: number;
  /** The settled PaymentIntent to refund against. */
  strandedPaymentIntentId: string;
  /** When the credit was refused, ISO-8601. */
  strandedAt: string;
  /** Always true — the flag operators query on. */
  requiresRefund: true;
}

/**
 * Builds the metadata stamp for a deposit that SETTLED at Stripe but could not
 * be credited (audit W-07).
 *
 * Pure so the anchor's shape is pinned by a test: an operator's refund query
 * depends on these exact keys, and a silent rename would re-hide the money.
 *
 * @param input.paymentIntentId Settled Stripe PaymentIntent.
 * @param input.amountCents Captured amount owed back.
 * @param input.at Timestamp of the refusal (injectable for tests).
 * @returns The stamp to merge into `wallet_transactions.metadata`.
 */
export function buildStrandedDepositStamp(input: {
  paymentIntentId: string;
  amountCents: number;
  at?: Date;
}): StrandedDepositStamp {
  return {
    failureReason: WALLET_DEPOSIT_FAILURE_WALLET_FROZEN,
    strandedAmountCents: input.amountCents,
    strandedPaymentIntentId: input.paymentIntentId,
    strandedAt: (input.at ?? new Date()).toISOString(),
    requiresRefund: true,
  };
}
