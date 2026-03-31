/**
 * @fileoverview RingTreasuryTab - Treasury/financial overview for a ring group.
 *
 * Shown within the ring detail page. Displays balance, transaction history,
 * and contribution management for the ring's shared treasury.
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
  Loader2,
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { TreasuryPaymentsCard } from "@/components/treasury-payments-card"
import {
  getGroupWalletAction,
  getTransactionHistoryAction,
  depositToGroupWalletAction,
} from "@/app/actions/wallet"
import { fetchGroupDetail } from "@/app/actions/graph"
import type { WalletBalance, WalletTransactionView } from "@/types"
import type { SerializedAgent } from "@/lib/graph-serializers"

interface RingTreasuryTabProps {
  ringId: string
  canManageStripe?: boolean
}

export function RingTreasuryTab({ ringId, canManageStripe = false }: RingTreasuryTabProps) {
  const { toast } = useToast()

  const [depositAmount, setDepositAmount] = useState("")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawPurpose, setWithdrawPurpose] = useState("")

  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  const [transactions, setTransactions] = useState<WalletTransactionView[]>([])
  const [members, setMembers] = useState<SerializedAgent[]>([])

  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isDepositing, setIsDepositing] = useState(false)

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)

    try {
      const [walletResult, txResult, groupResult] = await Promise.all([
        getGroupWalletAction(ringId),
        getTransactionHistoryAction({ limit: 50 }),
        fetchGroupDetail(ringId),
      ])

      if (walletResult.success && walletResult.wallet) {
        setWalletBalance(walletResult.wallet)
      } else {
        setLoadError(walletResult.error ?? "Failed to load group wallet.")
      }

      if (txResult.success && txResult.transactions) {
        setTransactions(txResult.transactions)
      }

      if (groupResult && groupResult.members) {
        setMembers(groupResult.members)
      }
    } catch {
      setLoadError("An unexpected error occurred loading treasury data.")
    } finally {
      setIsLoading(false)
    }
  }, [ringId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Derived values ─────────────────────────────────────────────────────

  const balanceDollars = walletBalance?.balanceDollars ?? 0
  const connectAvailDollars = walletBalance?.hasConnectAccount ? (walletBalance.connectAvailableCents ?? 0) / 100 : 0
  const connectPendDollars = walletBalance?.hasConnectAccount ? (walletBalance.connectPendingCents ?? 0) / 100 : 0
  const combinedBalanceDollars = balanceDollars + connectAvailDollars

  const totalDeposits = transactions
    .filter((tx) => tx.type === "deposit" || tx.type === "transfer_in")
    .reduce((sum, tx) => sum + tx.amountDollars, 0)

  const totalWithdrawals = transactions
    .filter((tx) => tx.type === "withdrawal" || tx.type === "transfer_out" || tx.type === "purchase")
    .reduce((sum, tx) => sum + tx.amountDollars, 0)

  const treasuryHealthPercent =
    totalDeposits > 0 ? Math.round((balanceDollars / totalDeposits) * 100) : 100

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleDeposit = async () => {
    const parsed = parseFloat(depositAmount)
    if (!depositAmount || isNaN(parsed) || parsed <= 0) return

    setIsDepositing(true)
    try {
      const amountCents = Math.round(parsed * 100)
      const result = await depositToGroupWalletAction(ringId, amountCents)

      if (result.success) {
        toast({
          title: "Deposit successful",
          description: `$${parsed.toFixed(2)} deposited to the ring treasury.`,
        })
        setDepositAmount("")
        await fetchData()
      } else {
        toast({
          title: "Deposit failed",
          description: result.error ?? "An unknown error occurred.",
          variant: "destructive",
        })
      }
    } catch {
      toast({
        title: "Deposit failed",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsDepositing(false)
    }
  }

  const handleWithdraw = () => {
    if (!withdrawAmount || !withdrawPurpose) return
    toast({
      title: "Not available yet",
      description: "Withdrawal requests are not yet available.",
    })
    setWithdrawAmount("")
    setWithdrawPurpose("")
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  const getStatusIcon = (status: string) => {
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

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)

  const getTransactionLabel = (tx: WalletTransactionView) => {
    const isInflow = tx.type === "deposit" || tx.type === "transfer_in"
    const verb = isInflow ? "Deposited" : "Withdrew"
    return `${verb} ${formatCurrency(tx.amountDollars)}`
  }

  const getTransactionActor = (tx: WalletTransactionView) => {
    const isInflow = tx.type === "deposit" || tx.type === "transfer_in"
    return isInflow ? (tx.fromWalletOwnerName ?? "Unknown") : (tx.toWalletOwnerName ?? "Unknown")
  }

  // ── Loading state ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-3 text-muted-foreground">Loading treasury data...</span>
      </div>
    )
  }

  if (loadError && !walletBalance) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-destructive font-medium">{loadError}</p>
        <Button variant="outline" onClick={fetchData}>
          Retry
        </Button>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <TreasuryPaymentsCard
        ownerId={ringId}
        entityLabel="ring"
        returnPath={`/rings/${ringId}?tab=treasury`}
        canManage={canManageStripe}
      />

      {loadError && (
        <div className="flex items-center gap-2 text-sm text-orange-600 px-1">
          <AlertCircle className="h-4 w-4" />
          <span>{loadError} Showing partial data.</span>
        </div>
      )}

      {/* Treasury Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Balance</p>
                <p className="text-2xl font-bold">{formatCurrency(combinedBalanceDollars)}</p>
                {walletBalance?.hasConnectAccount && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Treasury: {formatCurrency(balanceDollars)} + Sales: {formatCurrency(connectAvailDollars)}
                  </p>
                )}
                {connectPendDollars > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Pending: {formatCurrency(connectPendDollars)}
                  </p>
                )}
                {walletBalance?.isFrozen && (
                  <p className="text-xs text-red-600 mt-1">Wallet is frozen</p>
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
                <p className="text-sm font-medium text-muted-foreground">Members</p>
                <p className="text-2xl font-bold">{members.length}</p>
                <p className="text-xs text-muted-foreground">Active ring members</p>
              </div>
              <TrendingUp className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Monthly Business Flow</p>
                <p className="text-2xl font-bold text-green-600">{formatCurrency(0)}</p>
                <p className="text-xs text-muted-foreground">No ventures linked</p>
              </div>
              <TrendingUp className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Withdrawals</p>
                <p className="text-2xl font-bold">{formatCurrency(totalWithdrawals)}</p>
                <p className="text-xs text-muted-foreground">From transaction history</p>
              </div>
              <TrendingDown className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="ratios">Members</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Treasury Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Deposits</span>
                <span className="text-lg font-bold text-green-600">
                  {formatCurrency(totalDeposits)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Withdrawals</span>
                <span className="text-lg font-bold text-red-600">
                  {formatCurrency(totalWithdrawals)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Active Members</span>
                <span className="text-lg font-bold">{members.length}</span>
              </div>
              <div className="pt-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium">Treasury Health</span>
                  <span className="text-sm text-muted-foreground">
                    {treasuryHealthPercent}%
                  </span>
                </div>
                <Progress value={treasuryHealthPercent} className="h-2" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Transactions</CardTitle>
            </CardHeader>
            <CardContent>
              {transactions.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No transactions yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {transactions.map((tx) => {
                    const actorName = getTransactionActor(tx)
                    const initials = actorName.substring(0, 2).toUpperCase()
                    return (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between p-3 border rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{actorName}</p>
                            <p className="text-sm text-muted-foreground">
                              {getTransactionLabel(tx)}
                            </p>
                            {tx.description && (
                              <p className="text-xs text-muted-foreground">
                                Purpose: {tx.description}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(tx.status)}
                            <Badge className={getStatusColor(tx.status)}>{tx.status}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(tx.createdAt).toLocaleDateString()}
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
              <CardTitle>Ring Members</CardTitle>
            </CardHeader>
            <CardContent>
              {members.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No members found.
                </p>
              ) : (
                <div className="space-y-4">
                  {members.map((member, index) => {
                    const initials = member.name.substring(0, 2).toUpperCase()
                    return (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 border rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-bold">
                            {index + 1}
                          </div>
                          <Avatar className="h-10 w-10">
                            <AvatarImage
                              src={member.image || "/placeholder-user.jpg"}
                              alt={member.name}
                            />
                            <AvatarFallback>{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{member.name}</p>
                            <p className="text-sm text-muted-foreground">
                              Member
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">
                            Contribution ratios not yet tracked
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

        <TabsContent value="actions" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Make Deposit</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="deposit-amount">Amount ($)</Label>
                  <Input
                    id="deposit-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    min="0.01"
                    step="0.01"
                  />
                </div>
                <Button
                  onClick={handleDeposit}
                  className="w-full"
                  disabled={!depositAmount || isDepositing}
                >
                  {isDepositing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Depositing...
                    </>
                  ) : (
                    <>
                      <DollarSign className="h-4 w-4 mr-2" />
                      Deposit Funds
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Request Withdrawal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="withdraw-amount">Amount ($)</Label>
                  <Input
                    id="withdraw-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    min="0.01"
                    step="0.01"
                  />
                </div>
                <div>
                  <Label htmlFor="withdraw-purpose">Purpose</Label>
                  <Textarea
                    id="withdraw-purpose"
                    placeholder="Explain the purpose of this withdrawal"
                    value={withdrawPurpose}
                    onChange={(e) => setWithdrawPurpose(e.target.value)}
                  />
                </div>
                <Button
                  onClick={handleWithdraw}
                  className="w-full bg-transparent"
                  disabled={!withdrawAmount || !withdrawPurpose}
                  variant="outline"
                >
                  <TrendingDown className="h-4 w-4 mr-2" />
                  Request Withdrawal
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
