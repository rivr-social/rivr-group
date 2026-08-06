/**
 * Payroll-withholding math — pure, unit-tested. The ORG-side reserve layer:
 * an org configures a rate, and that share of every member job payout is
 * diverted into the org's own `payroll_withholding` wallet (a segregated
 * reserve the org later releases/remits itself).
 *
 * Distinct from `lib/tax/withholding.ts` (Chapter-3/backup withholding on the
 * PLATFORM's US-source payouts, keyed on payee foreignness) and from patronage
 * retention (member-owned equity). This layer keys ONLY on the paying org's
 * config; the compliance framing (employee payroll vs contractor reserve) is
 * the org's/advisor's call — see
 * docs/active/payroll-withholding-and-payout-schedule-design-2026-08-05.md §0.
 */

/** Ceiling on the configurable rate: 50%. A sanity clamp, not tax law. */
export const PAYROLL_WITHHOLDING_MAX_BPS = 5000;

export const PAYROLL_BPS_DIVISOR = 10000;

/** Clamp an org-supplied rate into [0, PAYROLL_WITHHOLDING_MAX_BPS], integer. */
export function clampPayrollWithholdingBps(rateBps: number): number {
  if (!Number.isFinite(rateBps)) return 0;
  return Math.min(PAYROLL_WITHHOLDING_MAX_BPS, Math.max(0, Math.round(rateBps)));
}

export interface PayrollWithholdingSplit {
  grossCents: number;
  withheldCents: number;
  netCents: number;
  /** The clamped rate actually applied. */
  effectiveRateBps: number;
}

/**
 * Split a gross payout into withheld + net at the org's rate. Withheld rounds
 * half-up per cent; net is always the exact remainder, so the two legs
 * reconcile to the gross by construction.
 */
export function computePayrollWithholding(
  grossCents: number,
  rateBps: number,
): PayrollWithholdingSplit {
  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    return { grossCents: Math.max(0, grossCents | 0), withheldCents: 0, netCents: Math.max(0, grossCents | 0), effectiveRateBps: 0 };
  }
  const effectiveRateBps = clampPayrollWithholdingBps(rateBps);
  const withheldCents = Math.min(
    grossCents,
    Math.round((grossCents * effectiveRateBps) / PAYROLL_BPS_DIVISOR),
  );
  return {
    grossCents,
    withheldCents,
    netCents: grossCents - withheldCents,
    effectiveRateBps,
  };
}

/** Receipt-metadata keys the two payout legs communicate through. */
export const PAYROLL_RECEIPT_KEYS = {
  grossCents: 'payrollGrossCents',
  withheldCents: 'payrollWithheldCents',
  netCents: 'payrollNetCents',
  rateBps: 'payrollRateBps',
} as const;

/**
 * The bank-leg amount for a job-payout receipt: the stamped payroll NET when
 * the internal leg diverted a reserve, else the full receipt amount. Reading
 * through this single helper is what keeps the two legs from drifting.
 */
export function bankLegAmountCents(receiptMetadata: Record<string, unknown>): number {
  const net = receiptMetadata[PAYROLL_RECEIPT_KEYS.netCents];
  if (typeof net === 'number' && Number.isInteger(net) && net >= 0) return net;
  const amount = receiptMetadata.amountCents;
  return typeof amount === 'number' && Number.isInteger(amount) ? amount : 0;
}

// ── Payout schedule (pure half; DB-backed get/set live in
//    payroll-withholding-config.ts) ────────────────────────────────────────

/** When attested payouts actually release to banks. 'manual' = attest releases immediately (today's behavior). */
export type PayoutCadence = 'manual' | 'daily' | 'weekly' | 'monthly';

export type PayoutScheduleConfig = {
  cadence: PayoutCadence;
  /** 0 (Sunday) – 6; weekly cadence only. */
  dayOfWeek?: number;
  /** 1–28; monthly cadence only (capped so every month qualifies). */
  dayOfMonth?: number;
};

export const DEFAULT_PAYOUT_SCHEDULE_CONFIG: PayoutScheduleConfig = { cadence: 'manual' };

const CADENCES: readonly PayoutCadence[] = ['manual', 'daily', 'weekly', 'monthly'];

/** Normalize an untrusted stored/submitted schedule into a valid one. */
export function normalizePayoutSchedule(raw: unknown): PayoutScheduleConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const cadence = CADENCES.includes(cfg.cadence as PayoutCadence)
    ? (cfg.cadence as PayoutCadence)
    : 'manual';
  const schedule: PayoutScheduleConfig = { cadence };
  if (cadence === 'weekly') {
    const day = typeof cfg.dayOfWeek === 'number' ? Math.round(cfg.dayOfWeek) : 5;
    schedule.dayOfWeek = Math.min(6, Math.max(0, day));
  }
  if (cadence === 'monthly') {
    const day = typeof cfg.dayOfMonth === 'number' ? Math.round(cfg.dayOfMonth) : 1;
    schedule.dayOfMonth = Math.min(28, Math.max(1, day));
  }
  return schedule;
}

/**
 * Whether a scheduled release is due at `now` (UTC) for the given schedule.
 * 'manual' is never due (attest itself releases). Daily is always due (the
 * cron's own cadence is the floor). Weekly/monthly match the configured day.
 */
export function isReleaseDue(schedule: PayoutScheduleConfig, now: Date): boolean {
  switch (schedule.cadence) {
    case 'manual':
      return false;
    case 'daily':
      return true;
    case 'weekly':
      return now.getUTCDay() === (schedule.dayOfWeek ?? 5);
    case 'monthly':
      return now.getUTCDate() === (schedule.dayOfMonth ?? 1);
  }
}
