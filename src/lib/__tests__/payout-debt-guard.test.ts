/**
 * Recovery-debt payout guard (PAY-16).
 *
 * A wallet may legitimately hold a NEGATIVE balance — that is chargeback /
 * refund recovery debt owed to the platform. Cash-out has to stay blocked until
 * future sales net it back to zero; otherwise the seller drains the money that
 * would have repaid it. The guard lived only in the person app; these tests pin
 * the semantics now that global and group share the implementation.
 */
import { describe, it, expect } from 'vitest';

import {
  RECOVERY_DEBT_PAYOUT_ERROR,
  assertNoRecoveryDebt,
  hasRecoveryDebt,
} from '@/lib/payout-debt-guard';

describe('hasRecoveryDebt', () => {
  it('is true for any negative balance — one cent of debt is still debt', () => {
    expect(hasRecoveryDebt(-1)).toBe(true);
    expect(hasRecoveryDebt(-2500)).toBe(true);
    expect(hasRecoveryDebt(Number.MIN_SAFE_INTEGER)).toBe(true);
  });

  it('is false at zero — a settled wallet may pay out', () => {
    expect(hasRecoveryDebt(0)).toBe(false);
    expect(hasRecoveryDebt(-0)).toBe(false);
  });

  it('is false for a positive balance', () => {
    expect(hasRecoveryDebt(1)).toBe(false);
    expect(hasRecoveryDebt(1_000_000)).toBe(false);
  });

  it('does not treat an unknown balance as debt (the caller reports that case)', () => {
    expect(hasRecoveryDebt(null)).toBe(false);
    expect(hasRecoveryDebt(undefined)).toBe(false);
    expect(hasRecoveryDebt(Number.NaN)).toBe(false);
  });
});

describe('assertNoRecoveryDebt', () => {
  it('throws the seller-facing recovery-debt reason on a negative balance', () => {
    expect(() => assertNoRecoveryDebt(-500)).toThrowError(RECOVERY_DEBT_PAYOUT_ERROR);
  });

  it('explains WHY payouts are blocked, not just "insufficient"', () => {
    expect(RECOVERY_DEBT_PAYOUT_ERROR).toMatch(/negative/i);
    expect(RECOVERY_DEBT_PAYOUT_ERROR).toMatch(/refund or chargeback/i);
    expect(RECOVERY_DEBT_PAYOUT_ERROR).not.toMatch(/insufficient/i);
  });

  it('passes a zero or positive balance through silently', () => {
    expect(() => assertNoRecoveryDebt(0)).not.toThrow();
    expect(() => assertNoRecoveryDebt(25_00)).not.toThrow();
  });

  it('passes an unknown balance through — the wallet-not-found path owns it', () => {
    expect(() => assertNoRecoveryDebt(null)).not.toThrow();
    expect(() => assertNoRecoveryDebt(undefined)).not.toThrow();
  });
});
