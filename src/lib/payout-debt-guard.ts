/**
 * Recovery-debt payout guard (PAY-16).
 *
 * A RIVR wallet may legitimately go NEGATIVE: when a refund or chargeback lands
 * after the seller's proceeds were already spendable, `lib/chargeback.ts` claws
 * the money back and leaves the balance below zero. That deficit is REAL DEBT
 * owed to the platform, netted off by the seller's future sales.
 *
 * Cash-out therefore has to stay blocked while the debt is outstanding —
 * otherwise the seller drains the money that would have repaid it (their Stripe
 * Connect balance is a SEPARATE pot, so a bank payout is not stopped by the
 * negative RIVR balance on its own) and walks away from the deficit.
 *
 * This module is the single, DB-free statement of that rule so every payout lane
 * (bank payout, Move-to-Stripe, and any future rail) enforces it identically and
 * reports it with the same honest message — "insufficient balance" hides WHY.
 * Ported from the person app's inline guard, which was the only implementation.
 */

/** User-facing reason a payout is refused while the wallet carries debt. */
export const RECOVERY_DEBT_PAYOUT_ERROR =
  'Your balance is negative after a refund or chargeback. Payouts resume once it returns to zero.';

/**
 * True when the wallet balance represents outstanding recovery debt.
 *
 * A missing/unknown balance is NOT treated as debt — the caller has already
 * failed to find the wallet by then and reports that separately.
 *
 * @param balanceCents The wallet's current balance in cents.
 */
export function hasRecoveryDebt(balanceCents: number | null | undefined): boolean {
  return typeof balanceCents === 'number' && Number.isFinite(balanceCents) && balanceCents < 0;
}

/**
 * Throws {@link RECOVERY_DEBT_PAYOUT_ERROR} when the wallet carries recovery
 * debt. Call it inside the payout lane's write body so the failure travels the
 * same path as every other payout rejection.
 *
 * @param balanceCents The wallet's current balance in cents.
 */
export function assertNoRecoveryDebt(balanceCents: number | null | undefined): void {
  if (hasRecoveryDebt(balanceCents)) {
    throw new Error(RECOVERY_DEBT_PAYOUT_ERROR);
  }
}
