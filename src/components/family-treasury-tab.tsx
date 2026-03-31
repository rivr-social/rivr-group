/**
 * @fileoverview FamilyTreasuryTab - Treasury dashboard for family groups.
 *
 * Shown within the family group detail page. Displays shared budget, savings goals,
 * expense tracking, and contribution management for the family treasury.
 */
"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  CheckCircle,
  Clock,
  XCircle,
  AlertCircle,
  Home,
  ShoppingCart,
  Car,
  Loader2,
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { getGroupWalletAction, getTransactionHistoryAction, depositToGroupWalletAction, requestFamilyWithdrawalAction, getFamilyContributionsAction } from "@/app/actions/wallet"
import { fetchGroupDetail } from "@/app/actions/graph"
import { TreasuryPaymentsCard } from "@/components/treasury-payments-card"
import type { WalletBalance, WalletTransactionView } from "@/types"
import type { SerializedAgent } from "@/lib/graph-serializers"

/**
 * Family treasury tab used on the family detail page to display treasury health, balances,
 * transactions, membership context, and family fund actions.
 * Key props:
 * - `familyId`: identifies which family wallet and membership data to load.
 */
interface FamilyTreasuryTabProps {
  familyId: string
  canManageStripe?: boolean
}

const CENTS_PER_DOLLAR = 100

/**
 * Renders the treasury dashboard and action forms for a specific family.
 *
 * @param {FamilyTreasuryTabProps} props - Component props.
 * @param {string} props.familyId - Family identifier used to fetch wallet, transaction, and member data.
 */
export function FamilyTreasuryTab({ familyId, canManageStripe = false }: FamilyTreasuryTabProps) {
  // Local form state for deposit and withdrawal action inputs.
  const [depositAmount, setDepositAmount] = useState("")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawPurpose, setWithdrawPurpose] = useState("")

  // Data/state lifecycle for async loading, optimistic UI flags, and error rendering.
  const [wallet, setWallet] = useState<WalletBalance | null>(null)
  const [transactions, setTransactions] = useState<WalletTransactionView[]>([])
  const [members, setMembers] = useState<SerializedAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [depositing, setDepositing] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [contributions, setContributions] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  const { toast } = useToast()

  const loadData = useCallback(async () => {
    // Resets loading/error state before running parallel fetches.
    setLoading(true)
    setError(null)

    try {
      // Data-fetching side effects: loads wallet balance, transaction history, and family member details.
      const [walletResult, txResult, groupResult, contribResult] = await Promise.all([
        getGroupWalletAction(familyId),
        getTransactionHistoryAction({ limit: 50 }),
        fetchGroupDetail(familyId),
        getFamilyContributionsAction(familyId),
      ])

      if (walletResult.success && walletResult.wallet) {
        setWallet(walletResult.wallet)
      } else {
        // Surfaces wallet fetch errors while still allowing other data to populate.
        setError(walletResult.error ?? "Unable to load wallet data.")
      }

      if (txResult.success && txResult.transactions) {
        // Stores normalized transaction history for summaries and transaction tab rendering.
        setTransactions(txResult.transactions)
      }

      if (groupResult?.members) {
        // Stores resolved family members for the Members tab.
        setMembers(groupResult.members)
      }

      if (contribResult.success) {
        setContributions(contribResult.contributions)
      }
    } catch (err) {
      // Converts unknown failures into user-safe messages for the error state.
      const message = err instanceof Error ? err.message : "Failed to load treasury data."
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [familyId])

  useEffect(() => {
    // Effect: reload treasury data whenever the family scope changes.
    loadData()
  }, [loadData])

  const handleDeposit = async () => {
    // Validates numeric positive amount before submitting to the server action.
    const parsedAmount = parseFloat(depositAmount)
    if (!depositAmount || isNaN(parsedAmount) || parsedAmount <= 0) return

    const amountCents = Math.round(parsedAmount * CENTS_PER_DOLLAR)
    // UI state flag disables the submit button and shows spinner feedback.
    setDepositing(true)

    try {
      // Server action side effect: deposits funds to the selected family wallet.
      const result = await depositToGroupWalletAction(familyId, amountCents)
      if (result.success) {
        toast({
          title: "Deposit successful",
          description: `$${parsedAmount.toFixed(2)} added to family treasury.`,
        })
        setDepositAmount("")
        // Refreshes wallet and transactions after a successful deposit.
        await loadData()
      } else {
        toast({
          title: "Deposit failed",
          description: result.error ?? "Unable to complete deposit.",
          variant: "destructive",
        })
      }
    } catch (err) {
      // Handles unexpected deposit failures with destructive toast feedback.
      const message = err instanceof Error ? err.message : "Deposit failed unexpectedly."
      toast({
        title: "Deposit error",
        description: message,
        variant: "destructive",
      })
    } finally {
      setDepositing(false)
    }
  }

  const handleWithdraw = async () => {
    const parsedAmount = parseFloat(withdrawAmount)
    if (!withdrawAmount || isNaN(parsedAmount) || parsedAmount <= 0) return
    if (!withdrawPurpose.trim()) return

    const amountCents = Math.round(parsedAmount * CENTS_PER_DOLLAR)
    setWithdrawing(true)

    try {
      const result = await requestFamilyWithdrawalAction(familyId, amountCents, withdrawPurpose.trim())
      if (result.success) {
        toast({
          title: "Withdrawal requested",
          description: `$${parsedAmount.toFixed(2)} withdrawal request submitted for "${withdrawPurpose.trim()}".`,
        })
        setWithdrawAmount("")
        setWithdrawPurpose("")
        await loadData()
      } else {
        toast({
          title: "Withdrawal failed",
          description: result.error ?? "Unable to submit withdrawal request.",
          variant: "destructive",
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Withdrawal request failed unexpectedly."
      toast({
        title: "Withdrawal error",
        description: message,
        variant: "destructive",
      })
    } finally {
      setWithdrawing(false)
    }
  }

  const getStatusIcon = (status: string) => {
    // Conditional status icon rendering for transaction state labels.
    switch (status) {
      case "completed":
      case "approved":
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case "pending":
        return <Clock className="h-4 w-4 text-yellow-600" />
      case "failed":
      case "rejected":
        return <XCircle className="h-4 w-4 text-red-600" />
      default:
        return <AlertCircle className="h-4 w-4 text-gray-600" />
    }
  }

  const getStatusColor = (status: string) => {
    // Conditional badge style selection for transaction state labels.
    switch (status) {
      case "completed":
      case "approved":
        return "bg-green-100 text-green-800"
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "failed":
      case "rejected":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getPurposeIcon = (description: string) => {
    // Conditional icon mapping by keyword category in transaction description text.
    const lower = description.toLowerCase()
    if (lower.includes("groceries") || lower.includes("food")) {
      return <ShoppingCart className="h-4 w-4" />
    }
    if (lower.includes("rent") || lower.includes("utilities")) {
      return <Home className="h-4 w-4" />
    }
    if (lower.includes("gas") || lower.includes("transport")) {
      return <Car className="h-4 w-4" />
    }
    return <DollarSign className="h-4 w-4" />
  }

  const totalDeposits = transactions
    // Derived summary metric for inbound treasury activity.
    .filter((tx) => tx.type === "deposit" || tx.type === "transfer_in")
    .reduce((sum, tx) => sum + tx.amountDollars, 0)

  const totalWithdrawals = transactions
    // Derived summary metric for outbound treasury activity.
    .filter((tx) => tx.type === "withdrawal" || tx.type === "transfer_out" || tx.type === "purchase")
    .reduce((sum, tx) => sum + tx.amountDollars, 0)

  // Conditional render: loading skeleton state while async data is in flight.
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-3 text-muted-foreground">Loading treasury data...</span>
      </div>
    )
  }

  // Conditional render: error recovery state when initial loading fails.
  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <div>
              <p className="font-medium">Unable to load treasury</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
          <Button variant="outline" className="mt-4" onClick={loadData}>
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  const balanceDollars = wallet?.balanceDollars ?? 0
  const connectAvailDollars = wallet?.hasConnectAccount ? (wallet.connectAvailableCents ?? 0) / 100 : 0
  const connectPendDollars = wallet?.hasConnectAccount ? (wallet.connectPendingCents ?? 0) / 100 : 0
  const combinedBalanceDollars = balanceDollars + connectAvailDollars
  // Derived health metric compares remaining balance against total incoming contributions.
  const healthPercent = totalDeposits > 0 ? Math.round((combinedBalanceDollars / totalDeposits) * 100) : 0

  return (
    <div className="space-y-6">
      <TreasuryPaymentsCard
        ownerId={familyId}
        entityLabel="family"
        returnPath={`/families/${familyId}?tab=treasury`}
        canManage={canManageStripe}
      />

      {/* Treasury Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Family Balance</p>
                <p className="text-2xl font-bold">${combinedBalanceDollars.toLocaleString()}</p>
                {wallet?.hasConnectAccount && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Treasury: ${balanceDollars.toLocaleString()} + Sales: ${connectAvailDollars.toLocaleString()}
                  </p>
                )}
                {connectPendDollars > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Pending: ${connectPendDollars.toLocaleString()}
                  </p>
                )}
              </div>
              <DollarSign className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Deposits</p>
                <p className="text-2xl font-bold">${totalDeposits.toLocaleString()}</p>
              </div>
              <TrendingUp className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Expenses</p>
                <p className="text-2xl font-bold">${totalWithdrawals.toLocaleString()}</p>
              </div>
              <TrendingDown className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        {/* Tab navigation splits overview, history, members, and action forms without changing route state. */}
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="ratios">Members</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Family Treasury Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Contributions</span>
                <span className="text-lg font-bold text-green-600">${totalDeposits.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Expenses</span>
                <span className="text-lg font-bold text-red-600">
                  ${totalWithdrawals.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Family Members</span>
                <span className="text-lg font-bold">{members.length}</span>
              </div>
              <div className="pt-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium">Treasury Health</span>
                  <span className="text-sm text-muted-foreground">
                    {healthPercent}%
                  </span>
                </div>
                <Progress value={Math.min(healthPercent, 100)} className="h-2" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Family Transactions</CardTitle>
            </CardHeader>
            <CardContent>
              {transactions.length === 0 ? (
                // Conditional render: empty state when no transactions are available.
                <p className="text-sm text-muted-foreground text-center py-8">No transactions yet.</p>
              ) : (
                <div className="space-y-4">
                  {transactions.map((transaction) => {
                    // Row-level derived display values for actor and transaction direction.
                    const senderName = transaction.fromWalletOwnerName ?? "Unknown"
                    const isDeposit = transaction.type === "deposit" || transaction.type === "transfer_in"
                    const displayName = isDeposit ? senderName : (transaction.toWalletOwnerName ?? senderName)
                    const description = transaction.description ?? ""

                    return (
                      <div key={transaction.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>{displayName.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{displayName}</p>
                            <div className="flex items-center gap-2">
                              {/* Conditional render: purpose icon only appears when description exists. */}
                              {description && getPurposeIcon(description)}
                              <p className="text-sm text-muted-foreground">
                                {isDeposit ? "Added" : "Spent"} $
                                {transaction.amountDollars.toLocaleString()}
                              </p>
                            </div>
                            {/* Conditional render: purpose details appear only when description exists. */}
                            {description && (
                              <p className="text-xs text-muted-foreground">For: {description}</p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(transaction.status)}
                            <Badge className={getStatusColor(transaction.status)}>{transaction.status}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(transaction.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ratios" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Family Members</CardTitle>
            </CardHeader>
            <CardContent>
              {members.length === 0 ? (
                // Conditional render: empty state when family members are unavailable.
                <p className="text-sm text-muted-foreground text-center py-8">No members found.</p>
              ) : (
                <div className="space-y-4">
                  {members.map((member, index) => (
                    <div key={member.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-family text-white text-sm font-bold">
                          {index + 1}
                        </div>
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={member.image || "/placeholder.svg"} alt={member.name} />
                          <AvatarFallback>{member.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{member.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {contributions[member.id] != null && contributions[member.id] > 0
                              ? `Contributed $${(contributions[member.id] / CENTS_PER_DOLLAR).toFixed(2)}`
                              : "No contributions yet"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="actions" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Add to Family Fund</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="deposit-amount">Amount ($)</Label>
                  <Input
                    id="deposit-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={depositAmount}
                    onChange={(e) => {
                      // Event handler keeps local deposit input state in sync with the field value.
                      setDepositAmount(e.target.value)
                    }}
                  />
                </div>
                <Button onClick={handleDeposit} className="w-full" disabled={!depositAmount || depositing}>
                  {depositing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <DollarSign className="h-4 w-4 mr-2" />
                  )}
                  {depositing ? "Depositing..." : "Add Funds"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Family Expense</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="withdraw-amount">Amount ($)</Label>
                  <Input
                    id="withdraw-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={withdrawAmount}
                    onChange={(e) => {
                      // Event handler keeps local withdrawal amount input state in sync.
                      setWithdrawAmount(e.target.value)
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="withdraw-purpose">What&apos;s this for?</Label>
                  <Textarea
                    id="withdraw-purpose"
                    placeholder="e.g., Groceries, utilities, family dinner..."
                    value={withdrawPurpose}
                    onChange={(e) => {
                      // Event handler keeps local withdrawal purpose text in sync.
                      setWithdrawPurpose(e.target.value)
                    }}
                  />
                </div>
                <Button
                  onClick={handleWithdraw}
                  className="w-full bg-transparent"
                  disabled={!withdrawAmount || !withdrawPurpose || withdrawing}
                  variant="outline"
                >
                  {withdrawing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <TrendingDown className="h-4 w-4 mr-2" />
                  )}
                  {withdrawing ? "Submitting..." : "Request Withdrawal"}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
