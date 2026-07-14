"use client"

/**
 * Project budget panel (backlog B14) — renders on the project page's Treasury
 * tab, above the expense panel.
 *
 * Shows the project's consolidated budget: obligations (committed) and actual
 * spend across job cash, on-platform purchases, card spend, and expenses, vs.
 * the authored `metadata.budget` target — plus (for admins) the dormant-flag-
 * aware project FinancialAccount + Issuing card controls (B13: projects get
 * their own FA in the group→subgroup→project cascade).
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Banknote, CreditCard, Loader2, Target } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  getProjectBankingOverviewAction,
  getProjectBudgetSummaryAction,
  issueProjectCardAction,
  provisionProjectFinancialAccountAction,
} from "@/app/actions/wallet"
import type { ProjectBankingOverview } from "@/app/actions/wallet"
import type { ProjectBudgetSummary } from "@/lib/budget-rollup"

interface ProjectBudgetPanelProps {
  projectId: string
  /** The project's owning group/subgroup agent id (hosts the FA). */
  ownerAgentId: string | null
  canManage: boolean
}

function usd(cents: number | null): string {
  if (cents === null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function ProjectBudgetPanel({ projectId, ownerAgentId, canManage }: ProjectBudgetPanelProps) {
  const [summary, setSummary] = useState<ProjectBudgetSummary | null>(null)
  const [banking, setBanking] = useState<ProjectBankingOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const { toast } = useToast()

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const [budgetResult, bankingResult] = await Promise.all([
        getProjectBudgetSummaryAction(projectId),
        canManage && ownerAgentId
          ? getProjectBankingOverviewAction(ownerAgentId, projectId)
          : Promise.resolve(null),
      ])
      if (budgetResult.success && budgetResult.summary) setSummary(budgetResult.summary)
      if (bankingResult?.success && bankingResult.overview) setBanking(bankingResult.overview)
      else setBanking(null)
    } finally {
      setIsLoading(false)
    }
  }, [projectId, ownerAgentId, canManage])

  useEffect(() => {
    void load()
  }, [load])

  const handleProvision = async () => {
    if (!ownerAgentId) return
    setPending(true)
    try {
      const result = await provisionProjectFinancialAccountAction(ownerAgentId, projectId)
      if (result.success) {
        toast({ title: "Project account ready", description: "This project now has its own sub-treasury account." })
        await load()
      } else {
        toast({ title: "Could not provision", description: result.error, variant: "destructive" })
      }
    } finally {
      setPending(false)
    }
  }

  const handleIssueCard = async () => {
    if (!ownerAgentId) return
    setPending(true)
    try {
      const result = await issueProjectCardAction(ownerAgentId, projectId)
      if (result.success) {
        toast({
          title: "Card issued",
          description: result.last4 ? `Virtual card ending in ${result.last4} is active.` : "Virtual card is active.",
        })
        await load()
      } else {
        toast({ title: "Could not issue card", description: result.error, variant: "destructive" })
      }
    } finally {
      setPending(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading budget…
        </CardContent>
      </Card>
    )
  }

  if (!summary) return null

  const pct =
    summary.budgetCents !== null && summary.budgetCents > 0
      ? Math.min(100, Math.max(0, (summary.committedCents / summary.budgetCents) * 100))
      : null
  const c = summary.components
  const rows: Array<[string, number]> = [
    ["Job cash (paid)", c.jobsPaidCents],
    ["Job cash (committed)", c.jobsCommittedCents],
    ["Purchases", c.purchasesCents],
    ["Card spend", c.cardExpensesCents],
    ["Other expenses", c.otherExpensesCents],
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" /> Budget
        </CardTitle>
        <CardDescription>Job cash, purchases, and card spend against this project&apos;s budget.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Budget</p>
            <p className="text-lg font-semibold">{summary.budgetCents === null ? "—" : usd(summary.budgetCents)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Committed</p>
            <p className="text-lg font-semibold">{usd(summary.committedCents)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Spent</p>
            <p className="text-lg font-semibold">{usd(summary.spentCents)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Remaining</p>
            {summary.budgetCents === null ? (
              <p className="text-lg font-semibold text-muted-foreground">—</p>
            ) : (
              <p className={`text-lg font-semibold ${summary.overBudget ? "text-red-600" : "text-green-600"}`}>
                {usd(summary.remainingCents)}
              </p>
            )}
          </div>
        </div>

        {pct !== null && <Progress value={pct} className="h-2" />}
        {summary.overBudget && (
          <Badge variant="destructive">Over budget by {usd(Math.abs(summary.remainingCents ?? 0))}</Badge>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          {rows.map(([label, cents]) => (
            <div key={label} className="flex justify-between gap-2">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium">{usd(cents)}</span>
            </div>
          ))}
        </div>

        {canManage && banking && (
          <div className="rounded-lg border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Project account &amp; card</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {banking.financialAccountId ? (
                    <span className="flex items-center gap-1">
                      <Banknote className="h-3.5 w-3.5" /> {usd(banking.faCashCents)}
                    </span>
                  ) : (
                    <span>No dedicated account yet</span>
                  )}
                  {banking.cards.map((card) => (
                    <Badge key={card.id} variant="outline" className="flex items-center gap-1">
                      <CreditCard className="h-3 w-3" /> •••• {card.last4}
                      {card.spendingLimitCents !== null && (
                        <span className="text-muted-foreground">
                          ({usd(card.spendingLimitCents)}/{card.spendingLimitInterval ?? "month"})
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!banking.treasuryEnabled ? (
                  <span className="text-xs text-muted-foreground">Bank accounts not enabled yet</span>
                ) : !banking.financialAccountId ? (
                  <Button size="sm" variant="outline" disabled={pending} onClick={handleProvision}>
                    {pending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    Create account
                  </Button>
                ) : (
                  banking.issuingEnabled && (
                    <Button size="sm" variant="outline" disabled={pending} onClick={handleIssueCard}>
                      {pending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Issue card
                    </Button>
                  )
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
