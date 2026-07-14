/**
 * @fileoverview TreasuryTab - Group treasury dashboard with balance, transactions, and contributions.
 *
 * Displayed on the group detail page. Shows the group's treasury balance,
 * recent transactions, deposit/withdrawal actions, and member contribution history.
 */
"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import {
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  PieChart,
  Calendar,
  Download,
  Wallet,
  Receipt,
  Target,
  Loader2,
  AlertCircle,
  Inbox,
} from "lucide-react"
import {
  getGroupTreasuryFundsOverviewAction,
  getGroupTreasuryLedgerAction,
  getGroupWalletAction,
} from "@/app/actions/wallet"
import type { TreasuryLedgerEntry } from "@/app/actions/wallet"
import { TreasuryPaymentsCard } from "@/components/treasury-payments-card"
import { SubgroupBankingCard } from "@/components/subgroup-banking-card"
import { TreasuryFundsCard } from "@/components/treasury-funds-card"
import { CryptoTreasuryCard } from "@/components/crypto-treasury-card"
import { ShareClassesCard } from "@/components/share-classes-card"
import { TreasuryFlowChart } from "@/components/treasury-flow-chart"
import { computeTreasuryTopline } from "@/lib/treasury-topline"
import type { WalletBalance } from "@/types"

/** First millisecond of the current calendar month, as an ISO string. */
function currentMonthStartIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

interface TreasuryTabProps {
  groupId: string
  canManageStripe?: boolean
}

export function TreasuryTab({ groupId, canManageStripe = false }: TreasuryTabProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  // Recent consolidated treasury movements (group + funds + projects +
  // subgroups) shown in the Recent Activity + Transactions lists.
  const [recentEntries, setRecentEntries] = useState<TreasuryLedgerEntry[]>([])
  // This-month movements + inflow/outflow totals for the summary cards.
  const [monthEntries, setMonthEntries] = useState<TreasuryLedgerEntry[]>([])
  const [monthTotals, setMonthTotals] = useState<{ inflowCents: number; outflowCents: number; netCents: number }>({
    inflowCents: 0,
    outflowCents: 0,
    netCents: 0,
  })
  const [walletError, setWalletError] = useState<string | null>(null)
  const [isLoadingWallet, setIsLoadingWallet] = useState(true)
  // Sum of every treasury fund's own wallet balance (admin-only read; funds
  // aren't visible to non-admins, so this stays 0 for them and the topline
  // falls back to unallocated + Connect, same as before).
  const [fundsTotalCents, setFundsTotalCents] = useState(0)

  const fetchWalletData = useCallback(async () => {
    setIsLoadingWallet(true)
    setWalletError(null)

    try {
      const [walletResult, recentResult, monthResult, fundsResult] = await Promise.all([
        getGroupWalletAction(groupId),
        // Recent consolidated ledger across the whole treasury tree (B10: job
        // payouts debit the PROJECT wallet, so a group-wallet-only view missed
        // them).
        getGroupTreasuryLedgerAction(groupId, { limit: 20 }),
        // Month-to-date window drives the revenue/expense/net cards.
        getGroupTreasuryLedgerAction(groupId, { sinceIso: currentMonthStartIso(), limit: 100 }),
        canManageStripe ? getGroupTreasuryFundsOverviewAction(groupId) : Promise.resolve(null),
      ])

      if (walletResult.success && walletResult.wallet) {
        setWalletBalance(walletResult.wallet)
      } else {
        setWalletError(walletResult.error ?? "Failed to load group wallet.")
      }

      if (recentResult.success && recentResult.ledger) {
        setRecentEntries(recentResult.ledger.entries)
      }

      if (monthResult.success && monthResult.ledger) {
        setMonthEntries(monthResult.ledger.entries)
        setMonthTotals(monthResult.ledger.totals)
      }

      if (fundsResult?.success && fundsResult.overview) {
        setFundsTotalCents(
          fundsResult.overview.funds.reduce((sum, fund) => sum + fund.balanceCents, 0)
        )
      } else {
        setFundsTotalCents(0)
      }
    } catch {
      setWalletError("An unexpected error occurred loading wallet data.")
    } finally {
      setIsLoadingWallet(false)
    }
  }, [groupId, canManageStripe])

  useEffect(() => {
    fetchWalletData()
  }, [fetchWalletData])

  // Month-to-date summaries come from the treasury-signed totals (internal
  // fund/project moves are excluded, so funding a project never reads as an
  // expense).
  const monthlyRevenue = monthTotals.inflowCents / 100
  const monthlyExpenses = monthTotals.outflowCents / 100
  const netIncome = monthTotals.netCents / 100

  // Build revenue stream breakdown by grouping this month's inflows by type.
  const revenueStreams = (() => {
    const creditEntries = monthEntries.filter((tx) => tx.direction === "in")
    if (creditEntries.length === 0) return []

    const byType = new Map<string, number>()
    for (const tx of creditEntries) {
      const label = tx.type || "Other"
      byType.set(label, (byType.get(label) ?? 0) + tx.grossAmountCents / 100)
    }

    const totalRevenue = monthlyRevenue
    return Array.from(byType.entries())
      .map(([name, amount]) => ({
        name,
        amount,
        percentage: totalRevenue > 0 ? (amount / totalRevenue) * 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount)
  })()

  // Current month label for reports
  const currentMonthLabel = new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  })

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  // Export the loaded treasury transactions as a CSV the browser downloads.
  // Treasury transactions are auto-derived from real wallet/settlement flows
  // (there is no manual-entry model), so this simply serializes what's shown.
  const handleExportCsv = () => {
    const rows = [
      ["Date", "Type", "Description", "Direction", "Treasury account", "Counterparty", "Signed amount (USD)", "Status"],
      ...recentEntries.map((tx) => [
        new Date(tx.createdAt).toISOString(),
        tx.type,
        tx.description ?? "",
        tx.direction,
        tx.scopeLabel,
        tx.counterpartyLabel ?? "",
        (tx.signedAmountCents / 100).toFixed(2),
        tx.status,
      ]),
    ]
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `treasury-${groupId}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Treasury</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={recentEntries.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <TreasuryPaymentsCard
        ownerId={groupId}
        entityLabel="group"
        returnPath={`/groups/${groupId}?tab=treasury`}
        canManage={canManageStripe}
        onBalancesChanged={fetchWalletData}
      />

      {canManageStripe && <SubgroupBankingCard groupId={groupId} />}

      {canManageStripe && <TreasuryFundsCard groupId={groupId} onBalancesChanged={fetchWalletData} />}

      <CryptoTreasuryCard groupId={groupId} canManage={canManageStripe} />

      {/* Share classes: members see their own holdings; admins can author. */}
      <ShareClassesCard groupId={groupId} canManage={canManageStripe} />

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Current Balance</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingWallet ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            ) : walletError ? (
              <div>
                <div className="text-2xl font-bold">{formatCurrency(0)}</div>
                <p className="text-xs text-orange-600 flex items-center gap-1 mt-1">
                  <AlertCircle className="h-3 w-3" />
                  Unable to load wallet
                </p>
              </div>
            ) : walletBalance ? (
              (() => {
                const { totalDollars, breakdown } = computeTreasuryTopline(
                  walletBalance,
                  fundsTotalCents,
                  formatCurrency
                )

                return (
                  <div>
                    <div className="text-2xl font-bold">{formatCurrency(totalDollars)}</div>
                    {breakdown.length > 1 && (
                      <p className="text-xs text-muted-foreground mt-1">{breakdown.join(" + ")}</p>
                    )}
                    {walletBalance.hasConnectAccount && (walletBalance.connectPendingCents ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Pending: {formatCurrency((walletBalance.connectPendingCents ?? 0) / 100)}
                      </p>
                    )}
                    {walletBalance.isFrozen && (
                      <p className="text-xs text-red-600 mt-1">Wallet is frozen</p>
                    )}
                  </div>
                )
              })()
            ) : (
              <div className="text-2xl font-bold">{formatCurrency(0)}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Revenue</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{formatCurrency(monthlyRevenue)}</div>
            <p className="text-xs text-muted-foreground">
              Based on {monthEntries.filter((tx) => tx.direction === "in").length} transactions
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Expenses</CardTitle>
            <ArrowDownRight className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{formatCurrency(monthlyExpenses)}</div>
            <p className="text-xs text-muted-foreground">
              Based on {monthEntries.filter((tx) => tx.direction === "out").length} transactions
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Income</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${netIncome >= 0 ? "text-green-600" : "text-red-600"}`}>
              {formatCurrency(netIncome)}
            </div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="allocations">Allocations</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        {/* ── Allocations: how funds flow among the entities ── */}
        <TabsContent value="allocations" className="mt-6">
          <TreasuryFlowChart groupId={groupId} />
        </TabsContent>

        <TabsContent value="overview" className="space-y-6 mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Revenue Streams */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <PieChart className="h-5 w-5 mr-2" />
                  Revenue Streams
                </CardTitle>
                <CardDescription>This month&apos;s revenue breakdown</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {revenueStreams.length > 0 ? (
                  revenueStreams.map((stream, index) => (
                    <div key={index} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="capitalize">{stream.name}</span>
                        <span className="font-medium">{formatCurrency(stream.amount)}</span>
                      </div>
                      <Progress value={stream.percentage} className="h-2" />
                      <div className="text-xs text-muted-foreground text-right">
                        {stream.percentage.toFixed(1)}% of total revenue
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Inbox className="h-8 w-8 mb-2" />
                    <p className="text-sm">No revenue recorded yet</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Activity */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Receipt className="h-5 w-5 mr-2" />
                  Recent Activity
                </CardTitle>
                <CardDescription>Latest financial transactions</CardDescription>
              </CardHeader>
              <CardContent>
                {recentEntries.length > 0 ? (
                  <div className="space-y-4">
                    {recentEntries.slice(0, 5).map((tx) => {
                      const isCredit = tx.direction === "in"
                      const isInternal = tx.direction === "internal"
                      return (
                        <div key={tx.id} className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div
                              className={`p-2 rounded-full ${isInternal ? "bg-muted" : isCredit ? "bg-green-100" : "bg-red-100"}`}
                            >
                              {isCredit ? (
                                <ArrowUpRight className="h-4 w-4 text-green-600" />
                              ) : (
                                <ArrowDownRight className={`h-4 w-4 ${isInternal ? "text-muted-foreground" : "text-red-600"}`} />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">{tx.description ?? tx.type}</p>
                              <p className="text-xs text-muted-foreground">
                                {tx.scopeLabel}
                                {tx.counterpartyLabel && ` ${isCredit ? "←" : "→"} ${tx.counterpartyLabel}`}
                                {" • "}
                                {formatDate(tx.createdAt)}
                              </p>
                            </div>
                          </div>
                          <div
                            className={`text-sm font-medium ${isInternal ? "text-muted-foreground" : isCredit ? "text-green-600" : "text-red-600"}`}
                          >
                            {isInternal ? "" : isCredit ? "+" : "−"}
                            {formatCurrency(tx.grossAmountCents / 100)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Inbox className="h-8 w-8 mb-2" />
                    <p className="text-sm">No transactions yet</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">All Transactions</h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                Filter
              </Button>
              <Button variant="outline" size="sm">
                <Calendar className="mr-2 h-4 w-4" />
                Date Range
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {recentEntries.length > 0 ? (
                  recentEntries.map((tx) => {
                    const isCredit = tx.direction === "in"
                    const isInternal = tx.direction === "internal"
                    return (
                      <div key={tx.id} className="p-4 hover:bg-muted/50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div
                              className={`p-2 rounded-full ${isInternal ? "bg-muted" : isCredit ? "bg-green-100" : "bg-red-100"}`}
                            >
                              {isCredit ? (
                                <ArrowUpRight className="h-4 w-4 text-green-600" />
                              ) : (
                                <ArrowDownRight className={`h-4 w-4 ${isInternal ? "text-muted-foreground" : "text-red-600"}`} />
                              )}
                            </div>
                            <div>
                              <p className="font-medium">{tx.description ?? tx.type}</p>
                              <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                                <Badge variant="outline" className="text-xs">
                                  {tx.type}
                                </Badge>
                                {isInternal && (
                                  <Badge variant="secondary" className="text-xs">
                                    internal
                                  </Badge>
                                )}
                                <span>•</span>
                                <span>{formatDate(tx.createdAt)}</span>
                                <span>•</span>
                                <span>
                                  {tx.scopeLabel}
                                  {tx.counterpartyLabel && ` ${isCredit ? "←" : "→"} ${tx.counterpartyLabel}`}
                                </span>
                                {tx.status !== "completed" && (
                                  <Badge variant="secondary" className="text-xs">
                                    {tx.status}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`text-lg font-semibold ${isInternal ? "text-muted-foreground" : isCredit ? "text-green-600" : "text-red-600"}`}
                          >
                            {isInternal ? "" : isCredit ? "+" : "−"}
                            {formatCurrency(tx.grossAmountCents / 100)}
                          </div>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Inbox className="h-10 w-10 mb-3" />
                    <p className="text-sm font-medium">No transactions yet</p>
                    <p className="text-xs mt-1">Transactions will appear here as they occur</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="budget" className="space-y-6 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Monthly Budget</h3>
            <Button variant="outline" size="sm">
              <Target className="mr-2 h-4 w-4" />
              Configure Budget
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Budget Overview</CardTitle>
              <CardDescription>Set up budget categories to track spending</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Target className="h-10 w-10 mb-3" />
                <p className="text-sm font-medium">No budget configured</p>
                <p className="text-xs mt-1">Create budget categories to track and manage group spending</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reports" className="space-y-6 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Financial Reports</h3>
            <Button variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              Generate Report
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Monthly Summary</CardTitle>
                <CardDescription>{currentMonthLabel}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between">
                  <span>Total Revenue</span>
                  <span className="font-medium text-green-600">{formatCurrency(monthlyRevenue)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Total Expenses</span>
                  <span className="font-medium text-red-600">{formatCurrency(monthlyExpenses)}</span>
                </div>
                <div className="border-t pt-2">
                  <div className="flex justify-between font-semibold">
                    <span>Net Income</span>
                    <span className={netIncome >= 0 ? "text-green-600" : "text-red-600"}>
                      {formatCurrency(netIncome)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Year to Date</CardTitle>
                <CardDescription>{new Date().getFullYear()} Performance</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <p className="text-sm">Year-to-date reporting requires historical data</p>
                  <p className="text-xs mt-1">This will populate as more monthly data is collected</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Available Reports</CardTitle>
              <CardDescription>Download detailed financial reports</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Button variant="outline" className="justify-start h-auto p-4">
                  <div className="text-left">
                    <div className="font-medium">Profit & Loss Statement</div>
                    <div className="text-sm text-muted-foreground">Monthly P&L report</div>
                  </div>
                </Button>
                <Button variant="outline" className="justify-start h-auto p-4">
                  <div className="text-left">
                    <div className="font-medium">Cash Flow Statement</div>
                    <div className="text-sm text-muted-foreground">Track money in and out</div>
                  </div>
                </Button>
                <Button variant="outline" className="justify-start h-auto p-4">
                  <div className="text-left">
                    <div className="font-medium">Budget vs Actual</div>
                    <div className="text-sm text-muted-foreground">Compare planned vs actual spending</div>
                  </div>
                </Button>
                <Button variant="outline" className="justify-start h-auto p-4">
                  <div className="text-left">
                    <div className="font-medium">Transaction History</div>
                    <div className="text-sm text-muted-foreground">Complete transaction log</div>
                  </div>
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
