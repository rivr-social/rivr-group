"use client"

/**
 * Group budget rollup (backlog B14) — renders inside the group Treasury tab's
 * Budget sub-tab for admins.
 *
 * Shows the group's consolidated budget position aggregated project →
 * subgroup → group: obligations (committed), actual spend, and remaining vs.
 * the authored per-project targets, with a component breakdown (job cash,
 * purchases, card, expenses) and a per-project / per-subgroup drilldown.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Inbox, Loader2, Target } from "lucide-react"
import { getGroupBudgetRollupAction } from "@/app/actions/wallet"
import type { BudgetRollupNode, BudgetTotals, ProjectBudgetSummary } from "@/lib/budget-rollup"

interface BudgetRollupCardProps {
  groupId: string
}

function usd(cents: number | null): string {
  if (cents === null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Percent of budget committed (clamped 0–100 for the bar); null when no budget. */
function committedPct(totals: BudgetTotals): number | null {
  if (totals.budgetCents === null || totals.budgetCents <= 0) return null
  return Math.min(100, Math.max(0, (totals.committedCents / totals.budgetCents) * 100))
}

function ComponentBreakdown({ totals }: { totals: BudgetTotals }) {
  const c = totals.components
  const rows: Array<[string, number]> = [
    ["Job cash (paid)", c.jobsPaidCents],
    ["Job cash (committed)", c.jobsCommittedCents],
    ["Purchases", c.purchasesCents],
    ["Card spend", c.cardExpensesCents],
    ["Other expenses", c.otherExpensesCents],
  ]
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
      {rows.map(([label, cents]) => (
        <div key={label} className="flex justify-between gap-2">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium">{usd(cents)}</span>
        </div>
      ))}
    </div>
  )
}

function ProjectRow({ project }: { project: ProjectBudgetSummary }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{project.projectName}</p>
        <p className="text-xs text-muted-foreground">
          {usd(project.spentCents)} spent · {usd(project.committedCents)} committed
          {project.budgetCents !== null && ` · ${usd(project.budgetCents)} budget`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {project.budgetCents === null ? (
          <Badge variant="outline">No budget</Badge>
        ) : project.overBudget ? (
          <Badge variant="destructive">Over by {usd(Math.abs(project.remainingCents ?? 0))}</Badge>
        ) : (
          <Badge variant="secondary">{usd(project.remainingCents)} left</Badge>
        )}
      </div>
    </div>
  )
}

function NodeSection({ node, depth }: { node: BudgetRollupNode; depth: number }) {
  const pct = committedPct(node.totals)
  return (
    <div className={depth > 0 ? "rounded-lg border p-3" : ""}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {node.agentName}
            {node.kind === "subgroup" && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">subgroup</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {usd(node.totals.spentCents)} spent · {usd(node.totals.committedCents)} committed
            {node.totals.budgetCents !== null && ` of ${usd(node.totals.budgetCents)}`}
          </p>
        </div>
        {node.totals.budgetCents !== null && (
          <Badge variant={node.totals.overBudget ? "destructive" : "secondary"} className="shrink-0">
            {node.totals.overBudget
              ? `Over by ${usd(Math.abs(node.totals.remainingCents ?? 0))}`
              : `${usd(node.totals.remainingCents)} left`}
          </Badge>
        )}
      </div>

      {pct !== null && <Progress value={pct} className="mt-2 h-2" />}

      {node.directProjects.length > 0 && (
        <div className="mt-2 divide-y">
          {node.directProjects.map((project) => (
            <ProjectRow key={project.projectId} project={project} />
          ))}
        </div>
      )}

      {node.children.length > 0 && (
        <div className="mt-3 space-y-3">
          {node.children.map((child) => (
            <NodeSection key={child.agentId} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function BudgetRollupCard({ groupId }: BudgetRollupCardProps) {
  const [rollup, setRollup] = useState<BudgetRollupNode | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await getGroupBudgetRollupAction(groupId)
      if (result.success && result.rollup) {
        setRollup(result.rollup)
      } else {
        setError(result.error ?? "Unable to load the budget rollup.")
      }
    } catch {
      setError("Unable to load the budget rollup.")
    } finally {
      setIsLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    void load()
  }, [load])

  const hasAnyProjects =
    rollup !== null &&
    (rollup.directProjects.length > 0 || rollup.children.some((c) => c.directProjects.length > 0 || c.children.length > 0))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" /> Budget rollup
        </CardTitle>
        <CardDescription>
          Job cash, on-platform purchases, and card spend across every project — rolled up through
          subgroups into the group total.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading budget…
          </div>
        ) : error ? (
          <p className="py-6 text-sm text-orange-600">{error}</p>
        ) : !rollup || !hasAnyProjects ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Inbox className="mb-2 h-8 w-8" />
            <p className="text-sm font-medium">No project budgets yet</p>
            <p className="text-xs">Set a budget on a project and its costs will roll up here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <NodeSection node={rollup} depth={0} />
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-sm font-medium">Where the money goes</p>
              <ComponentBreakdown totals={rollup.totals} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
