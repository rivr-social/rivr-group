import type Stripe from 'stripe';
import { assertAmountReconciled } from '@/lib/stripe-reconcile';

export interface TaxExclusiveCheckoutAmounts {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  shippingCents: number;
  chargedTotalCents: number;
}

/**
 * Reconciles RIVR's tax-exclusive metadata against Stripe's authoritative
 * Checkout totals. Internal settlement remains based on the pre-tax subtotal;
 * tax is recorded separately and is never credited as platform revenue.
 */
export function reconcileTaxExclusiveCheckout(
  session: Stripe.Checkout.Session,
  expectedPreTaxCents: number,
  context: string,
): TaxExclusiveCheckoutAmounts {
  const amountSubtotal = session.amount_subtotal;
  const amountTotal = session.amount_total;
  if (amountSubtotal == null || !Number.isInteger(amountSubtotal) || amountSubtotal < 0) {
    throw new Error(`Missing Stripe amount_subtotal for ${context}`);
  }
  if (amountTotal == null || !Number.isInteger(amountTotal) || amountTotal < 0) {
    throw new Error(`Missing Stripe amount_total for ${context}`);
  }

  assertAmountReconciled(amountSubtotal, expectedPreTaxCents, `${context}:subtotal`);

  const taxCents = session.total_details?.amount_tax ?? 0;
  const discountCents = session.total_details?.amount_discount ?? 0;
  const shippingCents = session.total_details?.amount_shipping ?? 0;
  const expectedChargedTotal =
    amountSubtotal - discountCents + taxCents + shippingCents;

  assertAmountReconciled(amountTotal, expectedChargedTotal, `${context}:total`);

  return {
    subtotalCents: amountSubtotal,
    taxCents,
    discountCents,
    shippingCents,
    chargedTotalCents: amountTotal,
  };
}
