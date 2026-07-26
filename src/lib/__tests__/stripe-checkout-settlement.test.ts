import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { reconcileTaxExclusiveCheckout } from '@/lib/stripe-checkout-settlement';

function session(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_test',
    object: 'checkout.session',
    amount_subtotal: 1000,
    amount_total: 1080,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 80,
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

describe('reconcileTaxExclusiveCheckout', () => {
  it('keeps Stripe tax outside the pre-tax settlement amount', () => {
    expect(reconcileTaxExclusiveCheckout(session(), 1000, 'test')).toEqual({
      subtotalCents: 1000,
      taxCents: 80,
      discountCents: 0,
      shippingCents: 0,
      chargedTotalCents: 1080,
    });
  });

  it('rejects a pre-tax metadata mismatch', () => {
    expect(() => reconcileTaxExclusiveCheckout(session(), 990, 'test')).toThrow(
      /amount mismatch/i,
    );
  });

  it('rejects an inconsistent tax-inclusive total', () => {
    expect(() =>
      reconcileTaxExclusiveCheckout(session({ amount_total: 1090 }), 1000, 'test'),
    ).toThrow(/amount mismatch/i);
  });
});
