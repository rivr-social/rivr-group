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
  Plus,
  Wallet,
  Receipt,
  Target,
  Loader2,
  AlertCircle,
  Inbox,
} from "lucide-react"
import { getGroupWalletAction, getTransactionHistoryAction } from "@/app/actions/wallet"
import { TreasuryPaymentsCard } from "@/components/treasury-payments-card"
import type { WalletBalance, WalletTransactionView } from "@/types"

interface TreasuryTabProps {
  groupId: string
  canManageStripe?: boolean
}

export function TreasuryTab({ groupId, canManageStripe = false }: TreasuryTabProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  const [walletTransactions, setWalletTransactions] = useState<WalletTransactionView[]>([])
  const [walletError, setWalletError] = useState<string | null>(null)
  const [isLoadingWallet, setIsLoadingWallet] = useState(true)

  const fetchWalletData = useCallback(async () => {
    setIsLoadingWallet(true)
    setWalletError(null)

    try {
      const [walletResult, txResult] = await Promise.all([
        getGroupWalletAction(groupId),
        getTransactionHistoryAction({ limit: 20 }),
      ])

      if (walletResult.success && walletResult.wallet) {
        setWalletBalance(walletResult.wallet)
      } else {
        setWalletError(walletResult.error ?? "Failed to load group wallet.")
      }

      if (txResult.success && txResult.transactions) {
        setWalletTransactions(txResult.transactions)
      }
    } catch {
      setWalletError("An unexpected error occurred loading wallet data.")
    } finally {
      setIsLoadingWallet(false)
    }
  }, [groupId])

  useEffect(() => {
    fetchWalletData()
  }, [fetchWalletData])

  // Compute financial summaries from real transaction data
  const monthlyRevenueCents = walletTransactions
    .filter((tx) => tx.amountCents > 0)
    .reduce((sum, tx) => sum + tx.amountCents, 0)
  const monthlyRevenue = monthlyRevenueCents / 100

  const monthlyExpensesCents = walletTransactions
    .filter((tx) => tx.amountCents < 0)
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0)
  const monthlyExpenses = monthlyExpensesCents / 100

  const netIncome = monthlyRevenue - monthlyExpenses

  // Build revenue stream breakdown by grouping positive transactions by type
  const revenueStreams = (() => {
    const creditTxs = walletTransactions.filter((tx) => tx.amountCents > 0)
    if (creditTxs.length === 0) return []

    const byType = new Map<string, number>()
    for (const tx of creditTxs) {
      const label = tx.type || "Other"
      byType.set(label, (byType.get(label) ?? 0) + tx.amountDollars)
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Treasury</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add Transaction
          </Button>
        </div>
      </div>

      <TreasuryPaymentsCard
        ownerId={groupId}
        entityLabel="group"
        returnPath={`/groups/${groupId}?tab=treasury`}
        canManage={canManageStripe}
      />

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
              <div>
                <div className="text-2xl font-bold">
                  {formatCurrency(
                    walletBalance.balanceDollars +
                    (walletBalance.hasConnectAccount ? (walletBalance.connectAvailableCents ?? 0) / 100 : 0)
                  )}
                </div>
                {walletBalance.hasConnectAccount && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Treasury: {formatCurrency(walletBalance.balanceDollars)} + Sales: {formatCurrency((walletBalance.connectAvailableCents ?? 0) / 100)}
                  </p>
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
              Based on {walletTransactions.filter((tx) => tx.amountCents > 0).length} transactions
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
              Based on {walletTransactions.filter((tx) => tx.amountCents < 0).length} transactions
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
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

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
                {walletTransactions.length > 0 ? (
                  <div className="space-y-4">
                    {walletTransactions.slice(0, 5).map((tx) => {
                      const isCredit = tx.amountCents > 0
                      return (
                        <div key={tx.id} className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div
                              className={`p-2 rounded-full ${isCredit ? "bg-green-100" : "bg-red-100"}`}
                            >
                              {isCredit ? (
                                <ArrowUpRight className="h-4 w-4 text-green-600" />
                              ) : (
                                <ArrowDownRight className="h-4 w-4 text-red-600" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">{tx.description ?? tx.type}</p>
                              <p className="text-xs text-muted-foreground">
                                {tx.type} • {formatDate(tx.createdAt)}
                                {tx.fromWalletOwnerName && ` • From: ${tx.fromWalletOwnerName}`}
                                {tx.toWalletOwnerName && ` • To: ${tx.toWalletOwnerName}`}
                              </p>
                            </div>
                          </div>
                          <div
                            className={`text-sm font-medium ${isCredit ? "text-green-600" : "text-red-600"}`}
                          >
                            {isCredit ? "+" : ""}
                            {formatCurrency(tx.amountDollars)}
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
                {walletTransactions.length > 0 ? (
                  walletTransactions.map((tx) => {
                    const isCredit = tx.amountCents > 0
                    return (
                      <div key={tx.id} className="p-4 hover:bg-muted/50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div
                              className={`p-2 rounded-full ${isCredit ? "bg-green-100" : "bg-red-100"}`}
                            >
                              {isCredit ? (
                                <ArrowUpRight className="h-4 w-4 text-green-600" />
                              ) : (
                                <ArrowDownRight className="h-4 w-4 text-red-600" />
                              )}
                            </div>
                            <div>
                              <p className="font-medium">{tx.description ?? tx.type}</p>
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Badge variant="outline" className="text-xs">
                                  {tx.type}
                                </Badge>
                                <span>•</span>
                                <span>{formatDate(tx.createdAt)}</span>
                                {tx.fromWalletOwnerName && (
                                  <>
                                    <span>•</span>
                                    <span>From: {tx.fromWalletOwnerName}</span>
                                  </>
                                )}
                                {tx.toWalletOwnerName && (
                                  <>
                                    <span>•</span>
                                    <span>To: {tx.toWalletOwnerName}</span>
                                  </>
                                )}
                                {tx.status !== "completed" && (
                                  <Badge variant="secondary" className="text-xs">
                                    {tx.status}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`text-lg font-semibold ${isCredit ? "text-green-600" : "text-red-600"}`}
                          >
                            {isCredit ? "+" : ""}
                            {formatCurrency(tx.amountDollars)}
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
