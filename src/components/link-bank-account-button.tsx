"use client"

import { useTransition } from "react"
import { Landmark, Loader2 } from "lucide-react"
import { loadStripe } from "@stripe/stripe-js"
import { createBankLinkSessionAction, saveLinkedBankAccountAction } from "@/app/actions/wallet"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"

interface LinkBankAccountButtonProps {
  /** Managed wallet owner (group/project). Omit for the current user's own wallet. */
  ownerId?: string
  /** Called after the linked bank is persisted — refresh balances here. */
  onLinked?: () => void | Promise<void>
  variant?: "outline" | "default"
  disabled?: boolean
}

/**
 * Opens Stripe's secure Financial Connections modal for the owner's connected
 * account and persists the linked bank (wallet metadata), so its live external
 * balance can render in treasury/wallet views. Render only when the server says
 * linking is available (`getPaymentBalancesAction().canLinkBank`).
 */
export function LinkBankAccountButton({
  ownerId,
  onLinked,
  variant = "outline",
  disabled = false,
}: LinkBankAccountButtonProps) {
  const { toast } = useToast()
  const [isLinking, startLinking] = useTransition()

  const handleLinkBank = () => {
    startLinking(async () => {
      const session = await createBankLinkSessionAction(ownerId)
      if (!session.success || !session.clientSecret || !session.connectAccountId) {
        toast({
          title: "Unable to start bank linking",
          description: session.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
      if (!publishableKey) {
        toast({ title: "Stripe is not configured", description: "Missing publishable key.", variant: "destructive" })
        return
      }

      // The FC session was minted ON the connected account, so Stripe.js must be
      // scoped to it for collectFinancialConnectionsAccounts to accept the secret.
      const stripe = await loadStripe(publishableKey, { stripeAccount: session.connectAccountId })
      if (!stripe) {
        toast({ title: "Unable to load Stripe", description: "Please try again.", variant: "destructive" })
        return
      }

      const collected = await stripe.collectFinancialConnectionsAccounts({
        clientSecret: session.clientSecret,
      })
      if (collected.error) {
        toast({
          title: "Bank linking failed",
          description: collected.error.message ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      const linkedAccount = collected.financialConnectionsSession?.accounts?.[0]
      if (!linkedAccount) {
        toast({ title: "No bank account linked", description: "The linking flow was closed before completing." })
        return
      }

      const saved = await saveLinkedBankAccountAction(linkedAccount.id, ownerId)
      if (!saved.success) {
        toast({
          title: "Unable to save linked bank",
          description: saved.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      toast({ title: "Bank account linked", description: "Its live balance now shows here." })
      await onLinked?.()
    })
  }

  return (
    <Button variant={variant} onClick={handleLinkBank} disabled={disabled || isLinking}>
      {isLinking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Landmark className="mr-2 h-4 w-4" />}
      Link bank account
    </Button>
  )
}
