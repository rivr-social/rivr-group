/**
 * Marketplace checkout fee calculator for Connect-settled purchases.
 *
 * Purpose:
 * Starts from the seller's desired net price and grosses up the buyer total so
 * Stripe payment costs, Connect overhead, org commission, and Rivr's platform
 * margin are all covered while the seller still receives the listed price in
 * their connected account.
 */
import { MARKETPLACE_FEE_BPS, BPS_DIVISOR } from "@/lib/wallet-constants";

const STRIPE_CARD_PERCENT_BPS = 290;
const STRIPE_CARD_FIXED_CENTS = 30;
/** Flat RIVR margin component ($1.49), on top of the % margin — see calculateCheckoutFees. */
export const PLATFORM_MARGIN_FIXED_CENTS = 149;
const STRIPE_CONNECT_ACCOUNT_OVERHEAD_CENTS = 200;
/**
 * Connect-account overhead recovery rate for SMALL carts. Stripe's ~$2/month
 * active-account cost was previously folded in as a FLAT $2 per purchase,
 * which made micro-transactions absurd (a $6 item carried a $2.86 buyer fee —
 * ~48%). The overhead now scales at this rate and CAPS at the flat amount, so
 * a $6 cart recovers 30¢ while every cart ≥ $40 is priced exactly as before.
 */
const CONNECT_OVERHEAD_RECOVERY_BPS = 500;

/**
 * Cross-border transfer surcharge in basis points (1%), grossed into the
 * BUYER total when the seller's connected account lives outside the
 * platform country (US). Stripe's cross-border transfer fee runs
 * 0.25%–1% by corridor, plus ~1% currency conversion when the recipient
 * is paid in another currency — 1% covers the common same-currency
 * corridors; FX-heavy corridors may exceed it (tunable, revisit with
 * real corridor data). Same philosophy as every other component: the
 * payer covers it, the seller always nets face value.
 */
export const CROSS_BORDER_TRANSFER_BPS = 100;

/**
 * A referral fee/split recipient resolved server-side from group/locale/global
 * config. `bps` is basis points of the seller price; `cents` is the computed
 * amount the buyer total is grossed up by and that the recipient is paid at
 * settlement.
 */
export interface ReferralSplitInput {
  recipientId: string;
  recipientType: "group" | "locale" | "global";
  bps: number;
}

export interface ReferralSplitResult extends ReferralSplitInput {
  cents: number;
}

export interface CheckoutFeeResult {
  sellerPriceCents: number;
  buyerTotalCents: number;
  buyerPlatformFeeCents: number;
  sellerNetCents: number;
  platformFeeCents: number;
  orgCommissionCents: number;
  /** Per-recipient referral fee amounts (group/locale/global), buyer-funded. */
  referralSplits: ReferralSplitResult[];
  /** Sum of all referral split cents. */
  referralSplitTotalCents: number;
  applicationFeeCents: number;
  stripeProcessingFeeEstimateCents: number;
  connectAccountFeeEstimateCents: number;
  /** Cross-border transfer surcharge (buyer-funded; 0 for domestic sellers). */
  crossBorderFeeCents: number;
}


/**
 * Exact card-processing cost estimate for an arbitrary charged total, from
 * the SAME constants the gross-up uses — the single place Stripe's pricing
 * lives. Used by surfaces that price with their own policy formula but must
 * report/verify the true processing cost (lib/fees.ts).
 */
export function estimateStripeProcessingFeeCents(chargedTotalCents: number): number {
  if (!Number.isInteger(chargedTotalCents) || chargedTotalCents <= 0) return 0;
  return (
    Math.round((chargedTotalCents * STRIPE_CARD_PERCENT_BPS) / BPS_DIVISOR) +
    STRIPE_CARD_FIXED_CENTS
  );
}

/**
 * Gross a NET target up so that after Stripe's card fee (2.9% + 30¢) the platform
 * is left with `netCents` — i.e. the PAYER covers Stripe's cost, no RIVR margin.
 * Used where RIVR must break even but takes no cut (e.g. a wallet top-up: the
 * depositor gets exactly `netCents` credited and covers the processing fee).
 */
export function grossUpForStripeCents(netCents: number): number {
  if (!Number.isInteger(netCents) || netCents <= 0) return 0;
  return Math.ceil(
    (netCents + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_CARD_PERCENT_BPS / BPS_DIVISOR),
  );
}

export function calculateCheckoutFees(
  sellerPriceCents: number,
  options?: {
    orgCommissionBps?: number;
    referralSplits?: ReferralSplitInput[];
    /** Platform margin override in bps; defaults to MARKETPLACE_FEE_BPS (3.3%). */
    platformFeeBps?: number;
    /**
     * Flat platform-margin component in cents; defaults to
     * {@link PLATFORM_MARGIN_FIXED_CENTS} ($1.49). Pass 0 to take a pure-%
     * margin (or to exempt micro-transactions from the fixed component).
     */
    platformFeeFixedCents?: number;
    /**
     * Connect-account overhead folded into the platform's target net. Defaults
     * to the marketplace flat overhead; recurring dues pass 0 — their
     * per-member fee policy has no flat component, they only need the Stripe
     * processing gross-up.
     */
    connectOverheadCents?: number;
    /**
     * True when the seller's connected account is outside the platform
     * country — grosses CROSS_BORDER_TRANSFER_BPS into the buyer total so
     * Stripe's cross-border transfer fee never comes out of the seller's
     * face value or RIVR's margin.
     */
    crossBorderSeller?: boolean;
  },
): CheckoutFeeResult {
  if (!Number.isInteger(sellerPriceCents) || sellerPriceCents < 0) {
    throw new Error("sellerPriceCents must be a non-negative integer");
  }

  if (sellerPriceCents === 0) {
    return {
      sellerPriceCents: 0,
      buyerTotalCents: 0,
      buyerPlatformFeeCents: 0,
      sellerNetCents: 0,
      platformFeeCents: 0,
      orgCommissionCents: 0,
      referralSplits: [],
      referralSplitTotalCents: 0,
      applicationFeeCents: 0,
      stripeProcessingFeeEstimateCents: 0,
      connectAccountFeeEstimateCents: 0,
      crossBorderFeeCents: 0,
    };
  }

  const platformFeeBps =
    typeof options?.platformFeeBps === "number" && Number.isInteger(options.platformFeeBps)
      ? options.platformFeeBps
      : MARKETPLACE_FEE_BPS;
  const platformFeeFixedCents =
    typeof options?.platformFeeFixedCents === "number" && Number.isInteger(options.platformFeeFixedCents)
      ? options.platformFeeFixedCents
      : PLATFORM_MARGIN_FIXED_CENTS;
  // Unified RIVR margin (2026-07-20): a single 3.3% + $1.49 across every
  // transaction type, ON TOP of Stripe's real cost (the gross-up below) and the
  // Connect overhead. Replaces the old scattered 5%/legacy-payment-leg models.
  const platformFeeCents =
    Math.round((sellerPriceCents * platformFeeBps) / BPS_DIVISOR) + platformFeeFixedCents;

  const orgCommissionBps = options?.orgCommissionBps ?? 0;
  const orgCommissionCents =
    orgCommissionBps > 0
      ? Math.round((sellerPriceCents * orgCommissionBps) / BPS_DIVISOR)
      : 0;

  // Referral fee/split layer: each recipient's amount is grossed into the buyer
  // total alongside the platform fee + org commission, then redistributed to the
  // recipient wallet at settlement. Recipients with a non-positive amount are
  // dropped so we never emit zero-cent payouts.
  const referralSplits: ReferralSplitResult[] = (options?.referralSplits ?? [])
    .filter((split) => Number.isFinite(split.bps) && split.bps > 0)
    .map((split) => ({
      ...split,
      cents: Math.round((sellerPriceCents * split.bps) / BPS_DIVISOR),
    }))
    .filter((split) => split.cents > 0);
  const referralSplitTotalCents = referralSplits.reduce(
    (sum, split) => sum + split.cents,
    0,
  );

  const connectOverheadCents =
    typeof options?.connectOverheadCents === "number" &&
    Number.isInteger(options.connectOverheadCents) &&
    options.connectOverheadCents >= 0
      ? options.connectOverheadCents
      : Math.min(
          STRIPE_CONNECT_ACCOUNT_OVERHEAD_CENTS,
          Math.ceil((sellerPriceCents * CONNECT_OVERHEAD_RECOVERY_BPS) / BPS_DIVISOR),
        );

  const crossBorderFeeCents = options?.crossBorderSeller
    ? Math.round((sellerPriceCents * CROSS_BORDER_TRANSFER_BPS) / BPS_DIVISOR)
    : 0;

  const targetPlatformNetCents =
    platformFeeCents +
    orgCommissionCents +
    referralSplitTotalCents +
    connectOverheadCents +
    crossBorderFeeCents;

  const grossBeforeStripeFixedCents =
    sellerPriceCents + targetPlatformNetCents + STRIPE_CARD_FIXED_CENTS;
  const buyerTotalCents = Math.ceil(
    grossBeforeStripeFixedCents / (1 - STRIPE_CARD_PERCENT_BPS / BPS_DIVISOR),
  );

  const stripeProcessingFeeEstimateCents =
    Math.round((buyerTotalCents * STRIPE_CARD_PERCENT_BPS) / BPS_DIVISOR) +
    STRIPE_CARD_FIXED_CENTS;
  const applicationFeeCents = buyerTotalCents - sellerPriceCents;

  return {
    sellerPriceCents,
    buyerTotalCents,
    buyerPlatformFeeCents: applicationFeeCents,
    sellerNetCents: sellerPriceCents,
    platformFeeCents,
    orgCommissionCents,
    referralSplits,
    referralSplitTotalCents,
    applicationFeeCents,
    stripeProcessingFeeEstimateCents,
    connectAccountFeeEstimateCents: connectOverheadCents,
    crossBorderFeeCents,
  };
}
