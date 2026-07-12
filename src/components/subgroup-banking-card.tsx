"use client"

/**
 * Subgroup banking card — renders inside the group Treasury tab for admins.
 *
 * Shows the banking lane per architecture doc §3.3–3.5: each subgroup's
 * Treasury FinancialAccount balance and issued cards, with admin actions to
 * provision an FA and issue a spending-limited virtual card. The group-level
 * balances (Connect, group FA, linked external bank) render in
 * TreasuryPaymentsCard above this card; this card owns the SUBGROUP rows.
 *
 * Dormant-flag aware: when Treasury/Issuing are not enabled on the platform
 * the card explains that instead of surfacing dead buttons.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Banknote, CreditCard, Landmark, Loader2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  getGroupTreasuryBankingOverviewAction,
  issueSubgroupCardAction,
  provisionSubgroupFinancialAccountAction,
} from "@/app/actions/wallet"
import type { GroupTreasuryBankingOverview } from "@/app/actions/wallet"

interface SubgroupBankingCardProps {
  groupId: string
}

function formatUsd(cents: number | null): string {
  if (cents === null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function SubgroupBankingCard({ groupId }: SubgroupBankingCardProps) {
  const [overview, setOverview] = useState<GroupTreasuryBankingOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pendingSubgroupId, setPendingSubgroupId] = useState<string | null>(null)
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" /> Subgroup banking
        </CardTitle>
        <CardDescription>
          Give a subgroup its own balance and a spending-limited virtual card.
        </CardDescription>
        <CardDescription>
          Each subgroup treasury can hold its own sub-treasury account and spending-limited virtual card,
          funded from and isolated to that subgroup&apos;s balance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!overview.groupConnectAccountId && (
          <p className="text-sm text-muted-foreground">
            Set up the group&apos;s payment account first (above) — it hosts every subgroup account.
          </p>
        )}
        {overview.groupConnectAccountId && !overview.treasuryEnabled && (
          <p className="text-sm text-muted-foreground">
            Subgroup bank accounts aren&apos;t available on this community yet.
          </p>
        )}
        {overview.groupConnectAccountId && overview.treasuryEnabled && !hasSubgroups && (
          <p className="text-sm text-muted-foreground">This group has no subgroups yet.</p>
        )}

        {overview.groupConnectAccountId && overview.treasuryEnabled &&
          overview.subgroups.map((subgroup) => (
            <div
              key={subgroup.subgroupId}
              className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{subgroup.subgroupName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Banknote className="h-3.5 w-3.5" />
                    {subgroup.financialAccountId ? formatUsd(subgroup.faCashCents) : "No account yet"}
                  </span>
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
                {!subgroup.financialAccountId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingSubgroupId === subgroup.subgroupId}
                    onClick={() => handleProvision(subgroup.subgroupId)}
                  >
                    {pendingSubgroupId === subgroup.subgroupId && (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    Create account
                  </Button>
                ) : (
                  overview.issuingEnabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pendingSubgroupId === subgroup.subgroupId}
                      onClick={() => handleIssueCard(subgroup.subgroupId)}
                    >
                      {pendingSubgroupId === subgroup.subgroupId && (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      )}
                      Issue card
                    </Button>
                  )
                )}
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  )
}
