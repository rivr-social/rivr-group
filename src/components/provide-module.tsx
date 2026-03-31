/**
 * @fileoverview ProvideModule - In-person payment collection dialog for offerings.
 *
 * Used on offering/profile pages where a seller collects payment from a buyer
 * via Apple Pay / Google Pay (Stripe PaymentRequestButton) or wallet balance.
 * Integrates with legacy fee calculation and Stripe Connect payment flow.
 */
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSession } from "next-auth/react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, CreditCard, Loader2, Wallet } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Elements, PaymentRequestButtonElement, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type PaymentRequest, type Stripe } from "@stripe/stripe-js"
import { calculateLegacyCheckoutFeesCents, type LegacyFeeBreakdown } from "@/lib/fees"
import { purchaseWithWalletAction } from "@/app/actions/wallet"
import { createProvidePaymentAction } from "@/app/actions/wallet"

const stripeKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
const stripePromise = stripeKey ? loadStripe(stripeKey) : null

interface ProvideModuleProps {
  offeringId: string
  sellerId: string
  sellerName: string
  items: Array<{ name: string; priceCents: number; term: string }>
  triggerButton: React.ReactNode
}

/** Formats an integer cents value as a USD dollar string. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

type PaymentState = "idle" | "processing" | "success" | "error"

/**
 * Inner payment form rendered inside Stripe Elements context.
 * Manages Apple Pay / Google Pay availability detection and payment submission.
 */
function ProvidePaymentForm({
  offeringId,
  totalCents,
  subtotalCents,
  onSuccess,
  onError,
}: {
  offeringId: string
  totalCents: number
  subtotalCents: number
  onSuccess: () => void
  onError: (message: string) => void
}) {
  const stripe = useStripe()
  const { toast } = useToast()
  const [paymentRequest, setPaymentRequest] = useState<PaymentRequest | null>(null)
  const [canMakePayment, setCanMakePayment] = useState<boolean | null>(null)
  const [walletLoading, setWalletLoading] = useState(false)

  useEffect(() => {
    if (!stripe) return

    const pr = stripe.paymentRequest({
      country: "US",
      currency: "usd",
      total: { label: "Offering Payment", amount: totalCents },
      requestPayerName: true,
      requestPayerEmail: true,
    })

    pr.canMakePayment().then((result) => {
      setCanMakePayment(result !== null)
      if (result !== null) {
        setPaymentRequest(pr)
      }
    })

    pr.on("paymentmethod", async (ev) => {
      try {
        const actionResult = await createProvidePaymentAction(offeringId)
        if (!actionResult.success || !actionResult.clientSecret) {
          ev.complete("fail")
          onError(actionResult.error ?? "Failed to create payment intent.")
          return
        }

        const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
          actionResult.clientSecret,
          { payment_method: ev.paymentMethod.id },
          { handleActions: false }
        )

        if (confirmError) {
          ev.complete("fail")
          onError(confirmError.message ?? "Payment confirmation failed.")
          return
        }

        ev.complete("success")

        if (paymentIntent?.status === "requires_action") {
          const { error: actionError } = await stripe.confirmCardPayment(actionResult.clientSecret)
          if (actionError) {
            onError(actionError.message ?? "Payment authentication failed.")
            return
          }
        }

        onSuccess()
      } catch {
        ev.complete("fail")
        onError("An unexpected error occurred during payment.")
      }
    })
  }, [stripe, totalCents, offeringId, onSuccess, onError])

  const handleWalletPurchase = async () => {
    if (walletLoading) return
    setWalletLoading(true)

    try {
      const result = await purchaseWithWalletAction(offeringId, subtotalCents)
      if (!result.success) {
        toast({
          title: "Wallet payment failed",
          description: result.error ?? "Unable to complete purchase with wallet.",
          variant: "destructive",
        })
        onError(result.error ?? "Wallet payment failed.")
        return
      }

      onSuccess()
    } catch {
      toast({
        title: "Something went wrong",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
      onError("An unexpected error occurred.")
    } finally {
      setWalletLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      {canMakePayment === null ? (
        <div className="flex items-center justify-center py-3">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : canMakePayment && paymentRequest ? (
        <PaymentRequestButtonElement
          options={{ paymentRequest }}
          className="w-full"
        />
      ) : (
        <p className="text-sm text-muted-foreground text-center py-2">
          Apple Pay / Google Pay not available on this device.
        </p>
      )}

      <Button
        variant="outline"
        className="w-full"
        onClick={handleWalletPurchase}
        disabled={walletLoading}
      >
        {walletLoading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Wallet className="h-4 w-4 mr-2" />
        )}
        {walletLoading ? "Processing..." : "Pay with Wallet"}
      </Button>
    </div>
  )
}

/**
 * Renders a payment collection dialog for in-person offering transactions.
 *
 * @param {ProvideModuleProps} props Offering and seller configuration.
 * @param {string} props.offeringId Offering resource id.
 * @param {string} props.sellerId Seller agent id.
 * @param {string} props.sellerName Seller display name.
 * @param {Array<{ name: string; priceCents: number; term: string }>} props.items Line items with pricing.
 * @param {React.ReactNode} props.triggerButton Custom trigger button element.
 */
export function ProvideModule({
  offeringId,
  sellerId: _sellerId,
  sellerName,
  items,
  triggerButton,
}: ProvideModuleProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [paymentState, setPaymentState] = useState<PaymentState>("idle")
  const [errorMessage, setErrorMessage] = useState<string>("")
  const { data: session } = useSession()
  const { toast } = useToast()

  const subtotalCents = useMemo(
    () => items.reduce((sum, item) => sum + item.priceCents, 0),
    [items]
  )

  const feeBreakdown: LegacyFeeBreakdown = useMemo(
    () => calculateLegacyCheckoutFeesCents(subtotalCents),
    [subtotalCents]
  )

  const handleSuccess = useCallback(() => {
    setPaymentState("success")
    toast({
      title: "Payment complete",
      description: `${formatCents(feeBreakdown.totalCents)} collected successfully.`,
    })
  }, [feeBreakdown.totalCents, toast])

  const handleError = useCallback((message: string) => {
    setPaymentState("error")
    setErrorMessage(message)
  }, [])

  const handleClose = () => {
    setIsOpen(false)
    setPaymentState("idle")
    setErrorMessage("")
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        handleClose()
      } else {
        setIsOpen(true)
      }
    }}>
      <DialogTrigger asChild>
        {triggerButton}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <CreditCard className="h-5 w-5" />
            Provide — {sellerName}&apos;s Offering
          </DialogTitle>
        </DialogHeader>

        {paymentState === "success" ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
            <p className="text-lg font-medium">Payment complete!</p>
            <Button onClick={handleClose}>Close</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Item list */}
            <Card>
              <CardContent className="p-4 space-y-3">
                {items.map((item, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{item.name}</span>
                      <Badge variant="secondary" className="text-xs">{item.term}</Badge>
                    </div>
                    <span className="text-sm font-medium">{formatCents(item.priceCents)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Fee breakdown */}
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCents(feeBreakdown.subtotalCents)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Platform fee</span>
                  <span>{formatCents(feeBreakdown.platformFeeCents + feeBreakdown.paymentFeeCents)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Sales tax</span>
                  <span>{formatCents(feeBreakdown.salesTaxCents)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between text-sm font-bold">
                  <span>Total</span>
                  <span>{formatCents(feeBreakdown.totalCents)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Error display */}
            {paymentState === "error" && errorMessage ? (
              <p className="text-sm text-destructive text-center">{errorMessage}</p>
            ) : null}

            {/* Payment options */}
            <Elements stripe={stripePromise}>
              <ProvidePaymentForm
                offeringId={offeringId}
                totalCents={feeBreakdown.totalCents}
                subtotalCents={subtotalCents}
                onSuccess={handleSuccess}
                onError={handleError}
              />
            </Elements>

            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
