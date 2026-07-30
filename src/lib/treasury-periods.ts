/**
 * Reporting periods for the treasury surfaces (audit T1-5, T-13).
 *
 * One definition of "this month" / "last month" / "year to date" / "all time",
 * shared by the Financial Reports card and the Transactions tab's date-range
 * picker. Both previously carried their own near-identical copy, which is how
 * the report's window and the ledger's window could drift apart while claiming
 * to describe the same span.
 *
 * The bounds are INCLUSIVE at both edges, matching the `sinceIso`/`untilIso`
 * contract of `getGroupTreasuryLedgerAction` (`>=` / `<=`) and of the budget
 * rollup, so one report's P&L half and budget half always cover exactly the
 * same period.
 *
 * Boundaries are computed in LOCAL time (a treasurer's "July" is their own
 * calendar month, not UTC's) and then serialized to ISO for the wire.
 */

/** Stable identifier for a reporting period. */
export type TreasuryPeriodKey = 'this_month' | 'last_month' | 'ytd' | 'all';

/** A selectable reporting window. `all` carries no bounds. */
export interface TreasuryPeriod {
  key: TreasuryPeriodKey;
  label: string;
  /** Inclusive lower bound, or `undefined` for all-time. */
  sinceIso?: string;
  /** Inclusive upper bound, or `undefined` for open-ended. */
  untilIso?: string;
}

/**
 * Builds the selectable reporting periods relative to a reference instant.
 *
 * @param now - The reference instant (injected so the math is testable).
 * @returns The periods in display order: this month, last month, YTD, all time.
 * @example
 * ```ts
 * const [thisMonth] = buildTreasuryPeriods(new Date());
 * await getGroupTreasuryLedgerAction(groupId, {
 *   sinceIso: thisMonth.sinceIso,
 *   untilIso: thisMonth.untilIso,
 * });
 * ```
 */
export function buildTreasuryPeriods(now: Date): TreasuryPeriod[] {
  const year = now.getFullYear();
  const month = now.getMonth();

  // Day 0 of a month is the last day of the previous one; 23:59:59.999 makes
  // the inclusive upper bound cover that final day completely.
  const lastMonthEnd = new Date(year, month, 0, 23, 59, 59, 999);

  return [
    {
      key: 'this_month',
      label: 'This month',
      sinceIso: new Date(year, month, 1).toISOString(),
      untilIso: now.toISOString(),
    },
    {
      key: 'last_month',
      label: 'Last month',
      sinceIso: new Date(year, month - 1, 1).toISOString(),
      untilIso: lastMonthEnd.toISOString(),
    },
    {
      key: 'ytd',
      label: 'Year to date',
      sinceIso: new Date(year, 0, 1).toISOString(),
      untilIso: now.toISOString(),
    },
    { key: 'all', label: 'All time' },
  ];
}

/**
 * Looks a period up by key, falling back to the first period when unknown.
 *
 * @param periods - The list from {@link buildTreasuryPeriods}.
 * @param key - The selected key.
 * @returns The matching period, or the first one.
 */
export function findTreasuryPeriod(
  periods: readonly TreasuryPeriod[],
  key: string,
): TreasuryPeriod {
  return periods.find((period) => period.key === key) ?? periods[0];
}
