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
/**
 * International-card buffer (fee-audit #2b/#3). Stripe charges MORE on
 * cross-border cards (~+1.5% cross-border + ~+1% currency conversion) than the
 * 2.9%+30¢ domestic rate, and the card's origin isn't known at checkout. Applied
 * ONLY to the ZERO-MARGIN gross-up (`grossUpForStripeCents`, e.g. the wallet
 * deposit) — the one path that actually goes NEGATIVE on an int'l card. The
 * margin-bearing marketplace paths (`calculateCheckoutFees`) already profit on
 * int'l cards (the 3.3%+$1.49 margin absorbs it), so they are deliberately NOT
 * buffered — doing so would reprice every domestic buyer and break the
 * "carts ≥ $40 price exactly as before" invariant. Fully covering the int'l
 * fee on the margin paths (to protect margin, not prevent loss) is a separate
 * PRICING decision for Cameron. Covers cross-border + FX worst case.
 */
const STRIPE_INTERNATIONAL_SURCHARGE_BPS = 250;
/** Effective card percent for the zero-margin gross-up — domestic + int'l buffer. */
const STRIPE_EFFECTIVE_PERCENT_BPS = STRIPE_CARD_PERCENT_BPS + STRIPE_INTERNATIONAL_SURCHARGE_BPS;
/** Flat RIVR margin component ($1.49), on top of the % margin — see calculateCheckoutFees. */
export const PLATFORM_MARGIN_FIXED_CENTS = 149;

/**
 * Cross-border transfer surcharge in basis points (0.25%), grossed into
 * the BUYER total when the seller's connected account lives outside the
 * platform country. Matches Stripe's documented cross-border payout fee
 * for full-agreement accounts on the classic Connect rail
 * (docs.stripe.com/connect/cross-border-payouts — 0.25%, waived UK↔EEA;
 * seller-side currency conversion at payout is borne by the connected
 * account under Stripe defaults, so this alone makes the platform
 * whole). Recipients outside the Connect regions ride the separate
 * Global Payouts rail (its per-payout pricing is handled there, not
 * here). Same philosophy as every component: the payer covers it, the
 * seller always nets face value.
 */
export const CROSS_BORDER_TRANSFER_BPS = 25;
/** Stripe's flat per-payout component on the Connect rail (25¢). */
export const CROSS_BORDER_PAYOUT_FLAT_CENTS = 25;

/**
 * GLOBAL PAYOUTS corridor (sellers outside the Connect regions, e.g.
 * Costa Rica): $1.50 flat per payout + volume tier (0.25%–1.25% by
 * country — worst tier assumed until corridor data) + 1% FX when Stripe
 * converts to the destination currency. Provisional per the Stripe docs
 * changelog/pricing trail — RE-CONFIRM when the Global Payouts
 * integration lands (it is a separate API surface; these constants only
 * make CHECKOUT pricing ready for it).
 */
export const GLOBAL_PAYOUT_FLAT_CENTS = 150;
export const GLOBAL_PAYOUT_VOLUME_BPS = 125;
export const GLOBAL_PAYOUT_FX_BPS = 100;

/** Which payout rail the seller's account settles on. */
export type SellerPayoutCorridor = "domestic" | "connect_cross_border" | "global_payouts";

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
  // Effective rate (domestic + int'l buffer) so a zero-margin gross-up (e.g. the
  // wallet deposit) can never go negative on an international card (fee-audit #3/#2b).
  return Math.ceil(
    (netCents + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_EFFECTIVE_PERCENT_BPS / BPS_DIVISOR),
  );
}

/** What a wallet top-up actually charges, itemized. All figures in cents. */
export interface DepositChargeBreakdown {
  /** What lands in the wallet — exactly what the depositor asked for. */
  creditCents: number;
  /** Card processing the DEPOSITOR covers so RIVR breaks even. */
  stripeFeeCoveredCents: number;
  /** What the card is actually charged: credit + processing. */
  chargeCents: number;
}

/**
 * Itemizes a wallet top-up so the DIALOG can disclose what the card will be
 * charged (audit PAY-36: the button said "Confirm $5.00" while the
 * PaymentIntent charged 561¢). Single source of truth — `createDepositIntent`
 * prices the PaymentIntent from this, and the UI discloses from this, so the
 * quoted figure and the charged figure cannot drift.
 *
 * @param creditCents The amount to land in the wallet, in cents.
 * @returns The itemized charge; all-zero for a non-positive/fractional request.
 */
export function describeDepositCharge(creditCents: number): DepositChargeBreakdown {
  const chargeCents = grossUpForStripeCents(creditCents);
  if (chargeCents <= 0) {
    return { creditCents: 0, stripeFeeCoveredCents: 0, chargeCents: 0 };
  }
  return {
    creditCents,
    stripeFeeCoveredCents: chargeCents - creditCents,
    chargeCents,
  };
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
     * Connect-account overhead folded into the platform's target net.
     * DEFAULTS TO 0 (Cameron, 2026-07-30): Stripe's ~$2/month active-account
     * cost is recovered ONCE, on the membership subscription that provisions
     * the connected account (the grossed "Connect settlement fee" line —
     * lib/membership-pricing.ts), never per purchase. Recovering it per
     * purchase double-charged every subscribed seller's buyers. Callers with
     * a genuine per-charge overhead may still pass one explicitly.
     */
    connectOverheadCents?: number;
    /**
     * The seller's payout corridor. Non-domestic corridors gross Stripe's
     * documented payout-side costs into the BUYER total so they never
     * come out of the seller's face value or RIVR's margin:
     * connect_cross_border → 0.25% + 25¢; global_payouts → $1.50 +
     * 1.25% volume + 1% FX (provisional — see constants above).
     */
    payoutCorridor?: SellerPayoutCorridor;
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
      : 0;

  const corridor: SellerPayoutCorridor = options?.payoutCorridor ?? "domestic";
  const crossBorderFeeCents =
    corridor === "connect_cross_border"
      ? Math.round((sellerPriceCents * CROSS_BORDER_TRANSFER_BPS) / BPS_DIVISOR) +
        CROSS_BORDER_PAYOUT_FLAT_CENTS
      : corridor === "global_payouts"
        ? Math.round(
            (sellerPriceCents * (GLOBAL_PAYOUT_VOLUME_BPS + GLOBAL_PAYOUT_FX_BPS)) /
              BPS_DIVISOR,
          ) + GLOBAL_PAYOUT_FLAT_CENTS
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
