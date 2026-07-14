"use client"

/**
 * Financial reports (backlog B15) — renders in the group Treasury tab's Reports
 * sub-tab for admins.
 *
 * A date-ranged report reflecting the whole treasury cascade: a Profit & Loss
 * from the consolidated ledger (external inflows vs. outflows by type, internal
 * fund/project moves excluded) plus the budget rollup top line. Exports to CSV
 * or JSON.
 */

import { useCallback, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Download, FileJson, Loader2 } from "lucide-react"
import { getGroupFinancialReportAction } from "@/app/actions/wallet"
import type { GroupFinancialReport } from "@/app/actions/wallet"

interface FinancialReportsCardProps {
  groupId: string
}

type RangeKey = "this_month" | "last_month" | "ytd" | "all"

interface Range {
  key: RangeKey
  label: string
  sinceIso?: string
  untilIso?: string
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Builds the selectable date ranges relative to now (computed at click time). */
function buildRanges(): Range[] {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const monthStart = new Date(y, m, 1)
  const lastMonthStart = new Date(y, m - 1, 1)
  const lastMonthEnd = new Date(y, m, 0, 23, 59, 59, 999)
  const yearStart = new Date(y, 0, 1)
  return [
    { key: "this_month", label: "This month", sinceIso: monthStart.toISOString(), untilIso: now.toISOString() },
    {
      key: "last_month",
      label: "Last month",
      sinceIso: lastMonthStart.toISOString(),
      untilIso: lastMonthEnd.toISOString(),
    },
    { key: "ytd", label: "Year to date", sinceIso: yearStart.toISOString(), untilIso: now.toISOString() },
    { key: "all", label: "All time" },
  ]
}

export function FinancialReportsCard({ groupId }: FinancialReportsCardProps) {
  const [ranges] = useState<Range[]>(buildRanges)
  const [activeKey, setActiveKey] = useState<RangeKey>("this_month")
  const [report, setReport] = useState<GroupFinancialReport | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeRange = ranges.find((r) => r.key === activeKey) ?? ranges[0]

  const generate = useCallback(
    async (range: Range) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await getGroupFinancialReportAction(groupId, {
          sinceIso: range.sinceIso,
          untilIso: range.untilIso,
        })
        if (result.success && result.report) {
          setReport(result.report)
        } else {
          setReport(null)
          setError(result.error ?? "Unable to generate the report.")
        }
      } catch {
        setError("Unable to generate the report.")
      } finally {
        setIsLoading(false)
      }
    },
    [groupId],
  )

  const download = (kind: "csv" | "json") => {
    if (!report) return
    let content: string
    let mime: string
    let ext: string
    if (kind === "json") {
      content = JSON.stringify(report, null, 2)
      mime = "application/json"
      ext = "json"
    } else {
      const lines: string[][] = [
        ["Section", "Line", "Inflow (USD)", "Outflow (USD)"],
        ["P&L", "Total revenue", (report.treasury.inflowCents / 100).toFixed(2), ""],
        ["P&L", "Total expenses", "", (report.treasury.outflowCents / 100).toFixed(2)],
        ["P&L", "Net", (report.treasury.netCents / 100).toFixed(2), ""],
        ...report.treasury.byType.map((t) => [
          "By type",
          t.type,
          (t.inflowCents / 100).toFixed(2),
          (t.outflowCents / 100).toFixed(2),
        ]),
      ]
      if (report.budget) {
        lines.push(["Budget", "Committed", "", (report.budget.totals.committedCents / 100).toFixed(2)])
        lines.push(["Budget", "Spent", "", (report.budget.totals.spentCents / 100).toFixed(2)])
        if (report.budget.totals.budgetCents !== null) {
          lines.push(["Budget", "Target", (report.budget.totals.budgetCents / 100).toFixed(2), ""])
        }
      }
      content = lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
      mime = "text/csv;charset=utf-8;"
      ext = "csv"
    }
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `financial-report-${groupId}-${activeKey}-${new Date().toISOString().slice(0, 10)}.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Financial reports</CardTitle>
        <CardDescription>
          Profit &amp; loss and budget across the whole treasury tree — group, subgroups, and projects —
          over a date range.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {ranges.map((range) => (
            <Button
              key={range.key}
              size="sm"
              variant={range.key === activeKey ? "default" : "outline"}
              onClick={() => {
                setActiveKey(range.key)
                void generate(range)
              }}
            >
              {range.label}
            </Button>
          ))}
          {report && (
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => download("csv")}>
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => download("json")}>
                <FileJson className="mr-1 h-3.5 w-3.5" /> JSON
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Generating {activeRange.label.toLowerCase()} report…
          </div>
        ) : error ? (
          <p className="py-4 text-sm text-orange-600">{error}</p>
        ) : !report ? (
          <p className="py-4 text-sm text-muted-foreground">
            Choose a period above to generate the report.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Revenue</p>
                <p className="text-lg font-semibold text-green-600">{usd(report.treasury.inflowCents)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Expenses</p>
                <p className="text-lg font-semibold text-red-600">{usd(report.treasury.outflowCents)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Net</p>
                <p
                  className={`text-lg font-semibold ${report.treasury.netCents >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  {usd(report.treasury.netCents)}
                </p>
              </div>
            </div>

            {report.treasury.byType.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">By type</p>
                <div className="divide-y rounded-lg border">
                  {report.treasury.byType.map((t) => (
                    <div key={t.type} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="capitalize">{t.type.replace(/_/g, " ")}</span>
                      <span className="flex gap-3">
                        {t.inflowCents > 0 && <span className="text-green-600">+{usd(t.inflowCents)}</span>}
                        {t.outflowCents > 0 && <span className="text-red-600">−{usd(t.outflowCents)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.budget && report.budget.totals.budgetCents !== null && (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="mb-1 font-medium">Budget</p>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span>Target: {usd(report.budget.totals.budgetCents)}</span>
                  <span>Committed: {usd(report.budget.totals.committedCents)}</span>
                  <span>Spent: {usd(report.budget.totals.spentCents)}</span>
                  <span className={report.budget.totals.overBudget ? "text-red-600" : "text-green-600"}>
                    {report.budget.totals.overBudget ? "Over budget" : `${usd(report.budget.totals.remainingCents ?? 0)} left`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
