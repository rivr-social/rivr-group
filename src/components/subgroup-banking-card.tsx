"use client"

/**
 * Subgroup banking + funding card — renders inside the group Treasury tab for
 * admins.
 *
 * Two lanes:
 * - FUNDING CASCADE (always available): move treasury money DOWN from the
 *   group into a subgroup's treasury as an internal ledger transfer
 *   (`fundSubgroupBalanceAction`) — the first hop of group → subgroup →
 *   project → job payout. Needs no Stripe.
 * - BANKING (dormant behind Treasury/Issuing): each subgroup's own
 *   FinancialAccount balance + spending-limited virtual card. When Treasury is
 *   not enabled the card explains that instead of surfacing dead buttons.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ArrowDownToLine, Banknote, CreditCard, Landmark, Loader2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  fundSubgroupBalanceAction,
  getGroupTreasuryBankingOverviewAction,
  issueSubgroupCardAction,
  provisionSubgroupFinancialAccountAction,
} from "@/app/actions/wallet"
import type { GroupTreasuryBankingOverview } from "@/app/actions/wallet"

interface SubgroupBankingCardProps {
  groupId: string
  /** Called after a successful funding move so the treasury topline refreshes. */
  onBalancesChanged?: () => void
}

function formatUsd(cents: number | null): string {
  if (cents === null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Parses a dollar string to whole cents, or null when invalid/non-positive. */
function dollarsToCents(raw: string): number | null {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100)
}

export function SubgroupBankingCard({ groupId, onBalancesChanged }: SubgroupBankingCardProps) {
  const [overview, setOverview] = useState<GroupTreasuryBankingOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pendingSubgroupId, setPendingSubgroupId] = useState<string | null>(null)
  const [fundingSubgroupId, setFundingSubgroupId] = useState<string | null>(null)
  const [fundAmount, setFundAmount] = useState("")
  const { toast } = useToast()

  const loadOverview = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await getGroupTreasuryBankingOverviewAction(groupId)
      if (result.success && result.overview) {
        setOverview(result.overview)
      }
    } finally {
      setIsLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const handleProvision = async (subgroupId: string) => {
    setPendingSubgroupId(subgroupId)
    try {
      const result = await provisionSubgroupFinancialAccountAction(groupId, subgroupId)
      if (result.success) {
        toast({ title: "Treasury account ready", description: "The subgroup now has its own sub-treasury account." })
        await loadOverview()
      } else {
        toast({ title: "Could not provision", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingSubgroupId(null)
    }
  }

  const handleIssueCard = async (subgroupId: string) => {
    setPendingSubgroupId(subgroupId)
    try {
      const result = await issueSubgroupCardAction(groupId, subgroupId)
      if (result.success) {
        toast({
          title: "Card issued",
          description: result.last4 ? `Virtual card ending in ${result.last4} is active.` : "Virtual card is active.",
        })
        await loadOverview()
      } else {
        toast({ title: "Could not issue card", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingSubgroupId(null)
    }
  }

  const handleFund = async (subgroupId: string) => {
    const amountCents = dollarsToCents(fundAmount)
    if (amountCents === null) {
      toast({ title: "Enter an amount", description: "Enter a positive dollar amount to move.", variant: "destructive" })
      return
    }
    setPendingSubgroupId(subgroupId)
    try {
      const result = await fundSubgroupBalanceAction(groupId, subgroupId, amountCents, "to_subgroup")
      if (result.success) {
        toast({ title: "Subgroup funded", description: `Moved ${formatUsd(amountCents)} into the subgroup treasury.` })
        setFundingSubgroupId(null)
        setFundAmount("")
        await loadOverview()
        onBalancesChanged?.()
      } else {
        toast({ title: "Could not move funds", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingSubgroupId(null)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading banking overview…
        </CardContent>
      </Card>
    )
  }

  if (!overview) return null

  const hasSubgroups = overview.subgroups.length > 0
  const bankingActive = Boolean(overview.groupConnectAccountId) && overview.treasuryEnabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" /> Subgroups &amp; banking
        </CardTitle>
        <CardDescription>
          Fund a subgroup&apos;s treasury from the group, and (when enabled) give it its own
          sub-treasury account and a spending-limited virtual card.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasSubgroups && (
          <p className="text-sm text-muted-foreground">This group has no subgroups yet.</p>
        )}

        {overview.groupConnectAccountId && !overview.treasuryEnabled && (
          <p className="text-sm text-muted-foreground">
            Subgroup bank accounts and cards aren&apos;t available on this community yet — you can still
            fund a subgroup treasury below.
          </p>
        )}

        {hasSubgroups &&
          overview.subgroups.map((subgroup) => {
            const isPending = pendingSubgroupId === subgroup.subgroupId
            const isFunding = fundingSubgroupId === subgroup.subgroupId
            return (
              <div key={subgroup.subgroupId} className="rounded-lg border p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{subgroup.subgroupName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      {bankingActive && (
                        <span className="flex items-center gap-1">
                          <Banknote className="h-3.5 w-3.5" />
                          {subgroup.financialAccountId ? formatUsd(subgroup.faCashCents) : "No account yet"}
                        </span>
                      )}
                      {subgroup.cards.map((card) => (
                        <Badge key={card.id} variant="outline" className="flex items-center gap-1">
                          <CreditCard className="h-3 w-3" /> •••• {card.last4}
                          {card.spendingLimitCents !== null && (
                            <span className="text-muted-foreground">
                              ({formatUsd(card.spendingLimitCents)}/{card.spendingLimitInterval ?? "month"})
                            </span>
                          )}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() => {
                        setFundingSubgroupId(isFunding ? null : subgroup.subgroupId)
                        setFundAmount("")
                      }}
                    >
                      <ArrowDownToLine className="mr-1 h-3 w-3" /> Fund
                    </Button>
                    {bankingActive && !subgroup.financialAccountId && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => handleProvision(subgroup.subgroupId)}
                      >
                        {isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        Create account
                      </Button>
                    )}
                    {bankingActive && subgroup.financialAccountId && overview.issuingEnabled && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => handleIssueCard(subgroup.subgroupId)}
                      >
                        {isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        Issue card
                      </Button>
                    )}
                  </div>
                </div>

                {isFunding && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">$</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      placeholder="Amount to move from the group"
                      value={fundAmount}
                      onChange={(e) => setFundAmount(e.target.value)}
                      className="h-8 max-w-[220px]"
                    />
                    <Button size="sm" disabled={isPending} onClick={() => handleFund(subgroup.subgroupId)}>
                      {isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Move funds
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
      </CardContent>
    </Card>
  )
}
