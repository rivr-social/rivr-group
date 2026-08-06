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
import type { TreasuryLedgerEntry, TreasuryTypeTotal } from "@/app/actions/wallet"
import { PayrollSettingsCard } from "@/components/payroll-settings-card"
import { TreasuryPaymentsCard } from "@/components/treasury-payments-card"
import { SubgroupBankingCard } from "@/components/subgroup-banking-card"
import { TreasuryFundsCard } from "@/components/treasury-funds-card"
import { CryptoTreasuryCard } from "@/components/crypto-treasury-card"
import { ShareClassesCard } from "@/components/share-classes-card"
import { TreasuryFlowChart } from "@/components/treasury-flow-chart"
import { BudgetRollupCard } from "@/components/budget-rollup-card"
import { FinancialReportsCard } from "@/components/financial-reports-card"
import { computeTreasuryTopline } from "@/lib/treasury-topline"
import {
  buildTreasuryCsvRows,
  toCsvText,
  EXPORT_MAX_ROWS,
} from "@/lib/treasury-ledger"
import { buildTreasuryPeriods, findTreasuryPeriod } from "@/lib/treasury-periods"
import { useToast } from "@/components/ui/use-toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { WalletBalance } from "@/types"

/** Rows fetched for the Transactions list (one page, server cap is 100). */
const TRANSACTIONS_PAGE_LIMIT = 100

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
  const [monthTotals, setMonthTotals] = useState<{
    inflowCents: number
    outflowCents: number
    netCents: number
    inflowCount: number
    outflowCount: number
  }>({
    inflowCents: 0,
    outflowCents: 0,
    netCents: 0,
    inflowCount: 0,
    outflowCount: 0,
  })
  /**
   * This month's inflow split by transaction type, over the WHOLE window and the
   * whole treasury tree (audit T1-1/T-04). Revenue Streams used to be derived
   * from the rendered PAGE of entries, so its slices were a subset of the
   * headline revenue they were divided by — percentages summed to less than
   * 100% — and for a member the page held only the rows they could see, which is
   * how "P2p_transfer $20.09 — 36.7% of total revenue" appeared on a surface
   * that should never show internal plumbing as revenue at all.
   */
  const [monthByType, setMonthByType] = useState<TreasuryTypeTotal[]>([])
  const [walletError, setWalletError] = useState<string | null>(null)
  const [isLoadingWallet, setIsLoadingWallet] = useState(true)
  // Sum of every treasury fund's own wallet balance (admin-only read; funds
  // aren't visible to non-admins, so this stays 0 for them and the topline
  // falls back to unallocated + Connect, same as before).
  const [fundsTotalCents, setFundsTotalCents] = useState(0)
  const [isExporting, setIsExporting] = useState(false)
  // Transactions tab: the selected window (T-13) and the rows within it.
  const [txRanges] = useState(() => buildTreasuryPeriods(new Date()))
  const [txRangeKey, setTxRangeKey] = useState<string>("all")
  const [txEntries, setTxEntries] = useState<TreasuryLedgerEntry[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [isLoadingTx, setIsLoadingTx] = useState(false)
  const { toast } = useToast()

  const activeTxRange = findTreasuryPeriod(txRanges, txRangeKey)

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
        // Month-to-date window drives the revenue/expense/net cards. Only the
        // server-side aggregates are read (totals + byType), never the rows —
        // so `limit: 1` is deliberate, not a truncation.
        getGroupTreasuryLedgerAction(groupId, { sinceIso: currentMonthStartIso(), limit: 1 }),
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
        setMonthTotals(monthResult.ledger.totals)
        setMonthByType(monthResult.ledger.byType)
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

  /**
   * The Transactions list, scoped to the selected date range (T-13). Kept
   * separate from the 20-row Recent Activity read so "All Transactions" shows a
   * full page of the chosen window rather than the same short recent slice.
   */
  const fetchTransactions = useCallback(async () => {
    setIsLoadingTx(true)
    try {
      const result = await getGroupTreasuryLedgerAction(groupId, {
        limit: TRANSACTIONS_PAGE_LIMIT,
        sinceIso: activeTxRange.sinceIso,
        untilIso: activeTxRange.untilIso,
      })
      if (result.success && result.ledger) {
        setTxEntries(result.ledger.entries)
        setTxTotal(result.ledger.total)
      }
    } finally {
      setIsLoadingTx(false)
    }
  }, [groupId, activeTxRange.sinceIso, activeTxRange.untilIso])

  useEffect(() => {
    void fetchTransactions()
  }, [fetchTransactions])

  // Month-to-date summaries come from the treasury-signed totals (internal
  // fund/project moves are excluded, so funding a project never reads as an
  // expense).
  const monthlyRevenue = monthTotals.inflowCents / 100
  const monthlyExpenses = monthTotals.outflowCents / 100
  const netIncome = monthTotals.netCents / 100

  // Revenue streams come from the server's window-wide, tree-wide `byType`
  // split — the same aggregate the headline revenue figure is summed from, so
  // the slices always reconcile to 100% of it (audit T1-1/T-04). Only external
  // inflows appear: an internal fund/project move contributes 0 to `inflowCents`
  // by construction, so it can no longer masquerade as a revenue stream.
  const revenueStreams = monthByType
    .filter((entry) => entry.inflowCents > 0)
    .map((entry) => ({
      name: entry.type || "Other",
      amount: entry.inflowCents / 100,
      percentage: monthTotals.inflowCents > 0 ? (entry.inflowCents / monthTotals.inflowCents) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)

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

  // Export the treasury ledger as a CSV the browser downloads.
  //
  // Audit T1-2, two defects fixed here:
  //  1. Every internal row exported "0.00" because `signedAmountCents` is 0 for
  //     a treasury-to-treasury move — correct for a P&L, useless as an audit
  //     trail, so allocations and sweeps looked like zero-value events. The row
  //     builder now emits a GROSS amount column (the real value moved, matching
  //     the UI) alongside the signed treasury effect.
  //  2. It serialized the 20 rows already on screen under a bare "Export"
  //     label. It now runs its OWN query over the selected date range, up to a
  //     named cap, and tells the user exactly how much it covered.
  //
  // Scope: the file contains exactly the rows this viewer is authorized to read
  // — the action returns a member only the group's own settlement legs — so no
  // extra gate is needed here. Serialization lives in the pure lib so the row
  // shape is unit-tested rather than asserted by eye.
  const handleExportCsv = async () => {
    setIsExporting(true)
    try {
      const result = await getGroupTreasuryLedgerAction(groupId, {
        forExport: true,
        limit: EXPORT_MAX_ROWS,
        sinceIso: activeTxRange.sinceIso,
        untilIso: activeTxRange.untilIso,
      })
      if (!result.success || !result.ledger) {
        toast({
          title: "Export failed",
          description: result.error ?? "Could not read the treasury ledger.",
          variant: "destructive",
        })
        return
      }

      const { entries, total } = result.ledger
      const truncated = total > entries.length
      downloadCsv(toCsvText(buildTreasuryCsvRows(entries)), truncated)
      // The old export was silent about covering only part of the ledger. Say
      // it plainly, and keep the file itself a clean rectangle so spreadsheets
      // and `read_csv` parse it without a ragged preamble row.
      toast({
        title: truncated ? "Exported a partial ledger" : "Treasury exported",
        description: truncated
          ? `${entries.length} of ${total} transactions (${activeTxRange.label.toLowerCase()}) — capped at ${EXPORT_MAX_ROWS.toLocaleString()} rows. Narrow the date range to export the rest.`
          : `${entries.length} transaction${entries.length === 1 ? "" : "s"} (${activeTxRange.label.toLowerCase()}).`,
        variant: truncated ? "destructive" : "default",
      })
    } finally {
      setIsExporting(false)
    }
  }

  /** Triggers the browser download for already-serialized CSV text. */
  const downloadCsv = (csv: string, truncated: boolean) => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    // A partial file is named as one, so a truncated export can never be
    // mistaken for the complete ledger once it leaves the browser.
    a.download = `treasury-${groupId}-${txRangeKey}-${new Date().toISOString().slice(0, 10)}${
      truncated ? "-partial" : ""
    }.csv`
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
            onClick={() => void handleExportCsv()}
            disabled={txTotal === 0 || isExporting}
          >
            <Download className="mr-2 h-4 w-4" />
            {isExporting ? "Exporting..." : "Export CSV"}
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

      {canManageStripe && <PayrollSettingsCard groupId={groupId} />}

      {canManageStripe && <SubgroupBankingCard groupId={groupId} onBalancesChanged={fetchWalletData} />}

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
              Based on {monthTotals.inflowCount} transactions
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
              Based on {monthTotals.outflowCount} transactions
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold">All Transactions</h3>
              <p className="text-xs text-muted-foreground">
                {isLoadingTx
                  ? "Loading…"
                  : txTotal > txEntries.length
                    ? `Showing ${txEntries.length} of ${txTotal} — ${activeTxRange.label.toLowerCase()}`
                    : `${txTotal} transaction${txTotal === 1 ? "" : "s"} — ${activeTxRange.label.toLowerCase()}`}
              </p>
            </div>
            {/* T-13: the old "Filter" and "Date Range" buttons had no onClick at
                all. Date Range is real now (the ledger action already took
                since/until); Filter had no server-side counterpart, so it was
                removed rather than left looking clickable. */}
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Select value={txRangeKey} onValueChange={setTxRangeKey}>
                <SelectTrigger className="w-[160px]" aria-label="Date range">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {txRanges.map((range) => (
                    <SelectItem key={range.key} value={range.key}>
                      {range.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {txEntries.length > 0 ? (
                  txEntries.map((tx) => {
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
                    <p className="text-sm font-medium">
                      {txRangeKey === "all" ? "No transactions yet" : "No transactions in this period"}
                    </p>
                    <p className="text-xs mt-1">
                      {txRangeKey === "all"
                        ? "Transactions will appear here as they occur"
                        : "Try a wider date range."}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="budget" className="space-y-6 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Budget</h3>
          </div>

          {canManageStripe ? (
            <BudgetRollupCard groupId={groupId} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Budget</CardTitle>
                <CardDescription>Project budgets roll up here for group admins.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Target className="h-10 w-10 mb-3" />
                  <p className="text-sm font-medium">Admins only</p>
                  <p className="text-xs mt-1">Group budget rollups are visible to treasury managers.</p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="reports" className="space-y-6 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Financial Reports</h3>
          </div>

          {canManageStripe ? (
            <FinancialReportsCard groupId={groupId} />
          ) : (
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
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
