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
