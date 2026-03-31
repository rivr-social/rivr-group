/**
 * Stripe amount reconciliation utilities.
 *
 * Ensures that metadata-supplied amounts match Stripe's authoritative
 * charge amounts, preventing client-side price manipulation attacks.
 */

const MAX_ROUNDING_TOLERANCE_CENTS = 1;

/**
 * Asserts that a metadata-claimed amount matches the Stripe-authoritative amount.
 * Throws if the difference exceeds rounding tolerance (1 cent).
 *
 * @param stripeAmount - Amount from Stripe's API (session.amount_total or pi.amount)
 * @param metadataAmount - Amount from checkout session/PI metadata
 * @param context - Descriptive context for error logging (e.g. session ID)
 */
export function assertAmountReconciled(
  stripeAmount: number,
  metadataAmount: number,
  context: string,
): void {
  if (Math.abs(stripeAmount - metadataAmount) > MAX_ROUNDING_TOLERANCE_CENTS) {
    const msg = `Payment amount mismatch: Stripe charged ${stripeAmount} but metadata claims ${metadataAmount} [${context}]`;
    console.error(msg);
    throw new Error(msg);
  }
}
