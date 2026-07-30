import { describe, expect, it } from "vitest"
import {
  buildTreasuryPeriods,
  findTreasuryPeriod,
  type TreasuryPeriod,
} from "@/lib/treasury-periods"

/**
 * Audit T1-5: a "Last month" report bounded its P&L half correctly ($0.00 for a
 * month with no activity) while the budget half reported July's spend, because
 * `untilIso` was dropped on the way to the budget rollup and the spend queries
 * carried no date predicate at all. These pin the WINDOW itself — that both
 * edges exist, that they don't overlap month to month, and that "all time" is
 * genuinely unbounded rather than a silently-clamped range.
 */

/** Mid-July 2026, local time — the audit's month on MAB. */
const JULY = new Date(2026, 6, 15, 10, 30, 0)

const byKey = (periods: TreasuryPeriod[], key: string) =>
  periods.find((period) => period.key === key)!

describe("buildTreasuryPeriods", () => {
  it("bounds this month at the first local millisecond of the month", () => {
    const period = byKey(buildTreasuryPeriods(JULY), "this_month")
    expect(new Date(period.sinceIso!)).toEqual(new Date(2026, 6, 1))
    expect(new Date(period.untilIso!)).toEqual(JULY)
  })

  it("bounds last month at BOTH edges, ending on the final millisecond of June", () => {
    const period = byKey(buildTreasuryPeriods(JULY), "last_month")
    expect(new Date(period.sinceIso!)).toEqual(new Date(2026, 5, 1))
    expect(new Date(period.untilIso!)).toEqual(new Date(2026, 5, 30, 23, 59, 59, 999))
  })

  it("leaves no gap and no overlap between last month and this month", () => {
    const periods = buildTreasuryPeriods(JULY)
    const lastEnd = new Date(byKey(periods, "last_month").untilIso!).getTime()
    const thisStart = new Date(byKey(periods, "this_month").sinceIso!).getTime()
    // Inclusive bounds: the two windows must be exactly 1ms apart, so no
    // transaction can fall into both periods or into neither.
    expect(thisStart - lastEnd).toBe(1)
  })

  it("starts year-to-date on January 1 of the reference year", () => {
    const period = byKey(buildTreasuryPeriods(JULY), "ytd")
    expect(new Date(period.sinceIso!)).toEqual(new Date(2026, 0, 1))
  })

  it("leaves all-time genuinely unbounded on both edges", () => {
    const period = byKey(buildTreasuryPeriods(JULY), "all")
    expect(period.sinceIso).toBeUndefined()
    expect(period.untilIso).toBeUndefined()
  })

  it("rolls last month back across a year boundary in January", () => {
    const periods = buildTreasuryPeriods(new Date(2026, 0, 10))
    const last = byKey(periods, "last_month")
    expect(new Date(last.sinceIso!)).toEqual(new Date(2025, 11, 1))
    expect(new Date(last.untilIso!)).toEqual(new Date(2025, 11, 31, 23, 59, 59, 999))
  })

  it("handles a 29-day February in a leap year", () => {
    const periods = buildTreasuryPeriods(new Date(2028, 2, 5))
    const last = byKey(periods, "last_month")
    expect(new Date(last.untilIso!)).toEqual(new Date(2028, 1, 29, 23, 59, 59, 999))
  })

  it("returns the periods in display order", () => {
    expect(buildTreasuryPeriods(JULY).map((p) => p.key)).toEqual([
      "this_month",
      "last_month",
      "ytd",
      "all",
    ])
  })
})

describe("findTreasuryPeriod", () => {
  it("finds a period by key", () => {
    const periods = buildTreasuryPeriods(JULY)
    expect(findTreasuryPeriod(periods, "ytd").key).toBe("ytd")
  })

  it("falls back to the first period for an unknown key", () => {
    const periods = buildTreasuryPeriods(JULY)
    expect(findTreasuryPeriod(periods, "nonsense").key).toBe("this_month")
  })
})
