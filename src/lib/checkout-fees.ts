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
const STRIPE_CONNECT_ACCOUNT_OVERHEAD_CENTS = 200;

export interface CheckoutFeeResult {
  sellerPriceCents: number;
  buyerTotalCents: number;
  buyerPlatformFeeCents: number;
  sellerNetCents: number;
  platformFeeCents: number;
  orgCommissionCents: number;
  applicationFeeCents: number;
  stripeProcessingFeeEstimateCents: number;
  connectAccountFeeEstimateCents: number;
}

export function calculateCheckoutFees(
  sellerPriceCents: number,
  options?: {
    orgCommissionBps?: number;
    platformFeeBps?: number;
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
      applicationFeeCents: 0,
      stripeProcessingFeeEstimateCents: 0,
      connectAccountFeeEstimateCents: 0,
    };
  }

  const platformFeeBps =
    typeof options?.platformFeeBps === "number" && Number.isInteger(options.platformFeeBps)
      ? options.platformFeeBps
      : MARKETPLACE_FEE_BPS;
  const platformFeeCents = Math.round((sellerPriceCents * platformFeeBps) / BPS_DIVISOR);

  const orgCommissionBps = options?.orgCommissionBps ?? 0;
  const orgCommissionCents =
    orgCommissionBps > 0
      ? Math.round((sellerPriceCents * orgCommissionBps) / BPS_DIVISOR)
      : 0;

  const targetPlatformNetCents =
    platformFeeCents + orgCommissionCents + STRIPE_CONNECT_ACCOUNT_OVERHEAD_CENTS;

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
    applicationFeeCents,
    stripeProcessingFeeEstimateCents,
    connectAccountFeeEstimateCents: STRIPE_CONNECT_ACCOUNT_OVERHEAD_CENTS,
  };
}
