"use client"

import { useEffect, useState, useTransition } from "react"
import { CreditCard, Loader2, Wallet } from "lucide-react"
import {
  getConnectBalanceAction,
  getConnectStatusAction,
  getPaymentBalancesAction,
  provisionTreasuryFinancialAccountAction,
  releaseTestConnectBalanceToWalletAction,
  requestPayoutAction,
  setupConnectAccountAction,
} from "@/app/actions/wallet"
import { LinkBankAccountButton } from "@/components/link-bank-account-button"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"

interface TreasuryPaymentsCardProps {
  ownerId: string
  entityLabel: string
  returnPath: string
  canManage: boolean
  /**
   * Called after a payout or test-sales release changes the Connect
   * available balance, so a parent headline balance card (if any) can
   * refetch instead of showing the pre-payout number.
   */
  onBalancesChanged?: () => void
}

export function TreasuryPaymentsCard({
  ownerId,
  entityLabel,
  returnPath,
  canManage,
  onBalancesChanged,
}: TreasuryPaymentsCardProps) {
  const isStripeTestMode =
    typeof process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY === "string" &&
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_")
  const { toast } = useToast()
  const [status, setStatus] = useState<{
    hasAccount: boolean
    chargesEnabled: boolean
    payoutsEnabled: boolean
    detailsSubmitted: boolean
    dashboardUrl?: string
  } | null>(null)
  const [balance, setBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null)
  // Extra balances beyond the Connect balance: Treasury FA cash + linked external
  // bank (Financial Connections). Populate only when Treasury/FC are live + linked.
  const [extraBalances, setExtraBalances] = useState<{
    treasuryUsdCents: number | null
    externalBankUsdCents: number | null
    canLinkBank: boolean
    bankLinked: boolean
    canProvisionTreasury: boolean
  } | null>(null)
  const [payoutAmount, setPayoutAmount] = useState("")
  const [initializing, setInitializing] = useState(true)
  const [isLoading, startLoading] = useTransition()

  useEffect(() => {
    let cancelled = false
    setInitializing(true)
    ;(async () => {
      try {
        const [statusResult, balanceResult, extraResult] = await Promise.all([
          getConnectStatusAction(ownerId),
          getConnectBalanceAction(ownerId),
          getPaymentBalancesAction(ownerId),
        ])

        if (cancelled) return

        if (statusResult.success && statusResult.status) {
          setStatus(statusResult.status)
        } else {
          setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false })
        }

        if (balanceResult.success && balanceResult.balance) {
          setBalance(balanceResult.balance)
        } else {
          setBalance({ availableCents: 0, pendingCents: 0 })
        }

        if (extraResult.success) {
          setExtraBalances({
            treasuryUsdCents: extraResult.treasury?.cash?.usd ?? null,
            externalBankUsdCents: extraResult.externalBank?.available?.usd ?? extraResult.externalBank?.current?.usd ?? null,
            canLinkBank: extraResult.canLinkBank ?? false,
            bankLinked: extraResult.bankLinked ?? false,
            canProvisionTreasury: extraResult.canProvisionTreasury ?? false,
          })
        }
      } catch {
        if (cancelled) return
        setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false })
        setBalance({ availableCents: 0, pendingCents: 0 })
      } finally {
        if (!cancelled) setInitializing(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [ownerId])

  const formatCents = (amountCents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountCents / 100)

  const handleSetup = () => {
    startLoading(async () => {
      const result = await setupConnectAccountAction(ownerId, returnPath)
      if (result.success && result.url) {
        window.location.href = result.url
        return
      }

      toast({
        title: "Couldn't set up payments",
        description: result.error ?? "Please try again.",
        variant: "destructive",
      })
    })
  }

  const handlePayout = (speed: "standard" | "instant") => {
    const amountCents = Math.round(Number.parseFloat(payoutAmount || "0") * 100)
    if (!amountCents || amountCents <= 0) {
      toast({
        title: "Invalid payout amount",
        description: "Enter a positive payout amount.",
        variant: "destructive",
      })
      return
    }

    startLoading(async () => {
      const result = await requestPayoutAction(amountCents, speed, ownerId)
      if (!result.success) {
        toast({
          title: "Couldn't send the payout",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Payout started",
        description: `${speed === "instant" ? "Instant" : "Standard"} payout initiated.`,
      })
      setPayoutAmount("")
      const balanceResult = await getConnectBalanceAction(ownerId)
      if (balanceResult.success && balanceResult.balance) {
        setBalance(balanceResult.balance)
      }
      onBalancesChanged?.()
    })
  }

  const handleReleaseTestSales = () => {
    startLoading(async () => {
      const result = await releaseTestConnectBalanceToWalletAction(ownerId)
      if (!result.success) {
        toast({
          title: "Couldn't release test sales",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Test sales released",
        description: result.releasedCents && result.releasedCents > 0
          ? `${formatCents(result.releasedCents)} moved into the treasury wallet for testing.`
          : "No new test sales were available to release.",
      })

      const balanceResult = await getConnectBalanceAction(ownerId)
      if (balanceResult.success && balanceResult.balance) {
        setBalance(balanceResult.balance)
      }
      onBalancesChanged?.()
    })
  }

  const refreshExtraBalances = async () => {
    const extraResult = await getPaymentBalancesAction(ownerId)
    if (extraResult.success) {
      setExtraBalances({
        treasuryUsdCents: extraResult.treasury?.cash?.usd ?? null,
        externalBankUsdCents: extraResult.externalBank?.available?.usd ?? extraResult.externalBank?.current?.usd ?? null,
        canLinkBank: extraResult.canLinkBank ?? false,
        bankLinked: extraResult.bankLinked ?? false,
        canProvisionTreasury: extraResult.canProvisionTreasury ?? false,
      })
    }
  }

  const handleProvisionTreasury = () => {
    startLoading(async () => {
      const result = await provisionTreasuryFinancialAccountAction(ownerId)
      if (!result.success) {
        toast({
          title: "Couldn't set up banking",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      toast({ title: "Banking is ready", description: "Its balance now shows here." })
      await refreshExtraBalances()
    })
  }

  if (!canManage) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5" />
          Stripe USD Wallet
        </CardTitle>
        <CardDescription>
          Connect this {entityLabel} treasury to Stripe so card purchases flow into its Stripe USD wallet and can be paid out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {initializing ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading payment settings...
          </div>
        ) : null}

        {!status?.hasAccount ? (
          <Button onClick={handleSetup} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
            Set up payments
          </Button>
        ) : (
          <>
            <div className="grid gap-2 text-sm">
              <div>
                {status.chargesEnabled && status.payoutsEnabled
                  ? "Ready to accept payments"
                  : status.detailsSubmitted
                    ? "A few more details needed"
                    : "Not set up yet"}
              </div>
              <div>Available Stripe balance: {formatCents(balance?.availableCents ?? 0)}</div>
              <div>Pending Stripe balance: {formatCents(balance?.pendingCents ?? 0)}</div>
              {extraBalances?.treasuryUsdCents != null ? (
                <div>Treasury balance: {formatCents(extraBalances.treasuryUsdCents)}</div>
              ) : null}
              {extraBalances?.externalBankUsdCents != null ? (
                <div>Linked bank balance: {formatCents(extraBalances.externalBankUsdCents)}</div>
              ) : null}
            </div>

            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <div className="mt-2 grid gap-2">
                <div>Charges enabled: {status.chargesEnabled ? "Yes" : "No"}</div>
                <div>Payouts enabled: {status.payoutsEnabled ? "Yes" : "No"}</div>
                <div>Details submitted: {status.detailsSubmitted ? "Yes" : "No"}</div>
                {isStripeTestMode && status.payoutsEnabled ? (
                  <div>
                    <Button variant="outline" size="sm" onClick={handleReleaseTestSales} disabled={isLoading}>
                      Release test sales
                    </Button>
                  </div>
                ) : null}
              </div>
            </details>

            {!status.chargesEnabled || !status.payoutsEnabled ? (
              <Button variant="outline" onClick={handleSetup} disabled={isLoading}>
                Finish verifying your account
              </Button>
            ) : null}

            {extraBalances?.canLinkBank && !extraBalances.bankLinked ? (
              <LinkBankAccountButton ownerId={ownerId} onLinked={refreshExtraBalances} disabled={isLoading} />
            ) : null}

            {extraBalances?.canProvisionTreasury ? (
              <Button variant="outline" onClick={handleProvisionTreasury} disabled={isLoading}>
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />}
                Set up banking (advanced)
              </Button>
            ) : null}

            {status.dashboardUrl ? (
              <Button variant="outline" asChild>
                <a href={status.dashboardUrl} target="_blank" rel="noreferrer">
                  Open payment dashboard
                </a>
              </Button>
            ) : null}

            {status.payoutsEnabled ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  <Input
                    value={payoutAmount}
                    onChange={(event) => setPayoutAmount(event.target.value)}
                    placeholder="Payout amount in USD"
                    inputMode="decimal"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => handlePayout("standard")} disabled={isLoading}>
                    Bank payout
                  </Button>
                  <Button variant="outline" onClick={() => handlePayout("instant")} disabled={isLoading}>
                    Instant payout
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Standard: free, 1–2 business days · Instant: small fee, arrives in minutes
                </p>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
