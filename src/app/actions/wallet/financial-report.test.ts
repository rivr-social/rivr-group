/**
 * Unit tests for `getGroupFinancialReportAction` (backlog B15).
 *
 * The report is a PURE COMPOSITION of two manage-gated actions
 * (`getGroupTreasuryLedgerAction` + `getGroupBudgetRollupAction`), so we mock
 * both siblings and assert the composition contract WITHOUT a database:
 *   - the manage gate (a member who cannot manage the tree gets no report);
 *   - error propagation from the ledger source;
 *   - the P&L is carried through even when the budget source is unavailable;
 *   - the date window is forwarded to BOTH sources and echoed on the report.
 *
 * Colocated (not under `__tests__/`) so it runs under `pnpm test:unit` — the
 * mocks mean it never touches `@/db`. Run with Node ≥22.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the two composed sibling actions BEFORE importing the unit under test so
// their real modules (which pull in `@/db`) never load.
vi.mock("./treasury-ledger", () => ({
  getGroupTreasuryLedgerAction: vi.fn(),
}))
vi.mock("./project-budget", () => ({
  getGroupBudgetRollupAction: vi.fn(),
}))

import { getGroupFinancialReportAction } from "./financial-report"
import { getGroupTreasuryLedgerAction } from "./treasury-ledger"
import { getGroupBudgetRollupAction } from "./project-budget"
import type { BudgetRollupNode } from "@/lib/budget-rollup"

const ledgerMock = vi.mocked(getGroupTreasuryLedgerAction)
const budgetMock = vi.mocked(getGroupBudgetRollupAction)

const GROUP_ID = "11111111-1111-1111-1111-111111111111"

/** A manager-visible ledger result with a small P&L and two by-type lines. */
function managerLedger() {
  return {
    success: true as const,
    ledger: {
      canManageTree: true,
      entries: [],
      total: 0,
      totals: { inflowCents: 5000, outflowCents: 1200, netCents: 3800 },
      byType: [
        { type: "sale", inflowCents: 5000, outflowCents: 0 },
        { type: "job_cash_payout", inflowCents: 0, outflowCents: 1200 },
      ],
    },
  }
}

/** A budget rollup whose totals the report should surface. */
function budgetRollup(): { success: true; rollup: BudgetRollupNode } {
  return {
    success: true,
    rollup: {
      agentId: GROUP_ID,
      agentName: "Spirit",
      kind: "group",
      directProjects: [],
      children: [],
      totals: {
        budgetCents: 100000,
        committedCents: 40000,
        spentCents: 15000,
        remainingCents: 60000,
        overBudget: false,
        components: {
          jobsCommittedCents: 40000,
          jobsPaidCents: 15000,
          purchasesCents: 0,
          cardExpensesCents: 0,
          otherExpensesCents: 0,
        },
      },
    },
  }
}

describe("getGroupFinancialReportAction", () => {
  beforeEach(() => {
    ledgerMock.mockReset()
    budgetMock.mockReset()
  })

  it("composes the P&L and budget top line for a manager", async () => {
    ledgerMock.mockResolvedValue(managerLedger())
    budgetMock.mockResolvedValue(budgetRollup())

    const result = await getGroupFinancialReportAction(GROUP_ID)

    expect(result.success).toBe(true)
    expect(result.report?.treasury).toEqual({
      inflowCents: 5000,
      outflowCents: 1200,
      netCents: 3800,
      byType: [
        { type: "sale", inflowCents: 5000, outflowCents: 0 },
        { type: "job_cash_payout", inflowCents: 0, outflowCents: 1200 },
      ],
    })
    expect(result.report?.budget?.totals.budgetCents).toBe(100000)
    expect(result.report?.budget?.totals.committedCents).toBe(40000)
  })

  it("denies the report to a member who cannot manage the tree", async () => {
    // A member CAN read the group-only ledger, but canManageTree is false.
    ledgerMock.mockResolvedValue({
      success: true,
      ledger: {
        canManageTree: false,
        entries: [],
        total: 0,
        totals: { inflowCents: 0, outflowCents: 0, netCents: 0 },
        byType: [],
      },
    })
    budgetMock.mockResolvedValue({ success: false, error: "not allowed" })

    const result = await getGroupFinancialReportAction(GROUP_ID)

    expect(result.success).toBe(false)
    expect(result.report).toBeUndefined()
    expect(result.error).toMatch(/treasury managers/i)
  })

  it("propagates a ledger-source failure without inventing a report", async () => {
    ledgerMock.mockResolvedValue({ success: false, error: "You must be logged in." })
    budgetMock.mockResolvedValue({ success: false, error: "You must be logged in." })

    const result = await getGroupFinancialReportAction(GROUP_ID)

    expect(result.success).toBe(false)
    expect(result.error).toBe("You must be logged in.")
  })

  it("still returns the P&L when the budget source is unavailable (budget: null)", async () => {
    ledgerMock.mockResolvedValue(managerLedger())
    budgetMock.mockResolvedValue({ success: false, error: "Group not found." })

    const result = await getGroupFinancialReportAction(GROUP_ID)

    expect(result.success).toBe(true)
    expect(result.report?.treasury.netCents).toBe(3800)
    expect(result.report?.budget).toBeNull()
  })

  it("forwards the date window to both sources and echoes it on the report", async () => {
    ledgerMock.mockResolvedValue(managerLedger())
    budgetMock.mockResolvedValue(budgetRollup())

    const sinceIso = "2026-07-01T00:00:00.000Z"
    const untilIso = "2026-07-31T23:59:59.999Z"
    const result = await getGroupFinancialReportAction(GROUP_ID, { sinceIso, untilIso })

    // The ledger read is date-ranged (both bounds) and paginated to a single row.
    expect(ledgerMock).toHaveBeenCalledWith(GROUP_ID, { limit: 1, sinceIso, untilIso })
    // The budget's card-spend component is date-bounded by sinceIso.
    expect(budgetMock).toHaveBeenCalledWith(GROUP_ID, { sinceIso })
    expect(result.report?.periodStartIso).toBe(sinceIso)
    expect(result.report?.periodEndIso).toBe(untilIso)
  })
})
