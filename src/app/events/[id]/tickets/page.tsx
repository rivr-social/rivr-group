"use client"

import Image from "next/image"
import { useEffect, useMemo, useState, use } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { ArrowRight, ChevronLeft, Globe, Minus, Plus, Wallet, CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"
import { useHomeFeed, useAgent } from "@/lib/hooks/use-graph-data"
import { agentToEvent } from "@/lib/graph-adapters"
import type { SerializedAgent } from "@/lib/graph-serializers"
import {
  estimateEventTicketCheckoutAction,
  getMyWalletAction,
  createEventTicketCheckoutAction,
  purchaseEventTicketsWithWalletAction,
} from "@/app/actions/wallet"
import { fetchEventTicketOfferingsAction } from "@/app/actions/event-form"
import type { WalletBalance } from "@/types"

/**
 * Ticket checkout page for a specific event.
 *
 * Route: `/events/[id]/tickets`
 * Rendering: Client Component (`"use client"`), with browser-managed state and effects.
 * Data requirements: Route `id`, event data from feed/detail actions, wallet balance, and checkout fee estimates.
 * Metadata: This file does not export `metadata` or `generateMetadata`; metadata is inherited.
 */
/**
 * Client-side ticket row model used for quantity selection and checkout totals.
 */
type TicketType = {
  id: string
  name: string
  priceCents: number
  description: string
  available: number | null
  quantity: number
}

/**
 * Renders ticket selection and checkout for an event.
 *
 * @param props - Async route params containing the event id.
 * @returns Ticket checkout UI, including payment method and order summary.
 */
export default function EventTicketsPage({ params }: { params: Promise<{ id: string }> }) {
  // Resolve the dynamic route param for the current event id.
  const resolvedParams = use(params)
  const router = useRouter()
  const { toast } = useToast()
  // Home feed provides optimistic/fallback event context while detail fetch resolves.
  const { data: homeData } = useHomeFeed(800, "all")

  // IndexedDB-first: useAgent reads event from local cache instantly, then syncs from server.
  const { agent: eventAgent } = useAgent(resolvedParams.id)
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<"card" | "wallet">("wallet")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feeBreakdown, setFeeBreakdown] = useState<{
    subtotalCents: number;
    platformFeeCents: number;
    salesTaxCents: number;
    paymentFeeCents: number;
    totalCents: number;
  } | null>(null)

  // Prefer feed data immediately when available for faster initial paint.
  const fallbackFromFeed = homeData.events.find((e) => e.id === resolvedParams.id)

  // Wallet balance still needs a server call (user-specific financial data).
  useEffect(() => {
    let cancelled = false
    getMyWalletAction()
      .then((result) => {
        if (!cancelled && result.success && result.wallet) setWalletBalance(result.wallet)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const event = useMemo(() => {
    // Use feed data first, then IndexedDB-backed agent data.
    if (fallbackFromFeed) return fallbackFromFeed
    if (!eventAgent) return null
    return agentToEvent(eventAgent)
  }, [eventAgent, fallbackFromFeed])

  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([])

  useEffect(() => {
    let cancelled = false
    async function loadTickets() {
      const offerings = await fetchEventTicketOfferingsAction(resolvedParams.id)
      if (cancelled) return
      if (offerings.length > 0) {
        setTicketTypes(
          offerings.map((offering) => ({
            id: offering.id,
            name: offering.name,
            priceCents: offering.priceCents,
            description: offering.description,
            available: offering.quantity,
            quantity: 0,
          }))
        )
        return
      }
      const fallbackPriceCents = event ? Math.round(Number(event.price || 0) * 100) : 0
      setTicketTypes([
        {
          id: "general-admission",
          name: "General Admission",
          priceCents: fallbackPriceCents,
          description: "Standard entry ticket",
          available: null,
          quantity: 0,
        },
      ])
    }
    void loadTickets()
    return () => {
      cancelled = true
    }
  }, [event, resolvedParams.id])

  const subtotalCents = useMemo(
    () => ticketTypes.reduce((sum, ticket) => sum + ticket.priceCents * ticket.quantity, 0),
    [ticketTypes]
  )
  const totalTickets = useMemo(
    () => ticketTypes.reduce((sum, ticket) => sum + ticket.quantity, 0),
    [ticketTypes]
  )

  useEffect(() => {
    let cancelled = false
    async function estimate() {
      if (subtotalCents <= 0) {
        // No selection means no fees to estimate.
        setFeeBreakdown(null)
        return
      }
      // Request server-side fee/tax estimate for the current subtotal.
      const result = await estimateEventTicketCheckoutAction(subtotalCents)
      if (!cancelled) {
        setFeeBreakdown(result.success && result.breakdown ? result.breakdown : null)
      }
    }
    void estimate()
    return () => {
      cancelled = true
    }
  }, [subtotalCents])

  /**
   * Updates quantity for a ticket type while enforcing [0, available] bounds.
   *
   * @param id - Ticket type id.
   * @param change - Increment/decrement amount.
   */
  const handleQuantityChange = (id: string, change: number) => {
    setTicketTypes((prev) =>
      prev.map((ticket) => {
        if (ticket.id !== id) return ticket
        const maxQuantity = ticket.available ?? Number.MAX_SAFE_INTEGER
        const quantity = Math.max(0, Math.min(maxQuantity, ticket.quantity + change))
        return { ...ticket, quantity }
      })
    )
  }

  const finalTotalCents = feeBreakdown?.totalCents ?? subtotalCents
  const selectedTickets = ticketTypes
    .filter((ticket) => ticket.quantity > 0)
    .map((ticket) => ({
      ticketProductId: ticket.id,
      quantity: ticket.quantity,
    }))

  /**
   * Starts checkout flow for wallet or card based on selected payment method.
   * Wallet purchases complete in-app; card purchases redirect to hosted checkout.
   */
  const handleCheckout = async () => {
    if (!event) return
    if (totalTickets === 0) {
      toast({
        title: "No tickets selected",
        description: "Please select at least one ticket to proceed.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    try {
      if (paymentMethod === "wallet") {
        // Wallet flow attempts direct purchase against current wallet balance.
        const result = await purchaseEventTicketsWithWalletAction(event.id, selectedTickets)
        if (!result.success) {
          toast({
            title: "Purchase failed",
            description: result.error ?? "Unable to complete ticket purchase.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        toast({
          title: "Purchase successful",
          description: `You purchased ${totalTickets} ticket(s) for ${event.name}.`,
        })
      } else {
        // Card flow creates hosted checkout and redirects the browser.
        const checkout = await createEventTicketCheckoutAction(event.id, selectedTickets)
        if (!checkout.success || !checkout.url) {
          toast({
            title: "Checkout failed",
            description: checkout.error ?? "Unable to start card checkout.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }
        window.location.href = checkout.url
        return
      }

      // Navigate to the post-registration confirmation route on success.
      router.push(`/events/${resolvedParams.id}/registered`)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Conditional rendering while event context is still unavailable.
  if (!event) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <Button variant="ghost" className="mb-4 -ml-2" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5 mr-1" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground">Loading event...</p>
      </div>
    )
  }

  const startDate = new Date(event.timeframe.start)
  const endDate = new Date(event.timeframe.end)
  // Wallet checkout button is blocked when balance cannot cover the full total.
  const walletInsufficient = !!walletBalance && walletBalance.balanceCents < finalTotalCents

  return (
    <div className="min-h-screen bg-gradient-to-br flex flex-col md:flex-row" style={{ background: "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 50%, #1e3a8a 100%)" }}>
      <div className="w-full md:w-2/5 p-6 flex items-center justify-center">
        <div className="relative w-full max-w-md aspect-square rounded-xl overflow-hidden shadow-2xl">
          <Image src={event.image || "/placeholder-event.jpg"} alt={event.name} fill className="object-cover" priority />
        </div>
      </div>

      <div className="w-full md:w-3/5 bg-background p-8 md:p-12 min-h-screen overflow-y-auto">
        <div className="max-w-2xl">
          <Button variant="ghost" className="mb-6 -ml-2 flex items-center" onClick={() => router.back()}>
            <ChevronLeft className="h-5 w-5 mr-1" />
            Back to event
          </Button>

          <div className="mb-8">
            <div className="flex items-center mb-2">
              <div className="bg-gray-100 rounded-lg p-2 mr-4 text-center min-w-[60px]">
                <div className="text-xs uppercase font-medium text-gray-500">{format(startDate, "MMM")}</div>
                <div className="text-2xl font-bold">{format(startDate, "d")}</div>
              </div>
            </div>
            <h1 className="text-4xl font-bold mb-2">{event.name}</h1>
            <div className="text-lg mb-6">
              {format(startDate, "EEEE, MMMM d")}
              <br />
              {format(startDate, "h:mm a")} - {format(endDate, "h:mm a")} {format(startDate, "z")}
            </div>
            <div className="flex items-center mb-2">
              <Globe className="h-5 w-5 mr-2 text-gray-500" />
              <span>{typeof event.location === "object" ? event.location.name || "Location TBD" : "Location TBD"}</span>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Select Tickets</h2>
            <div className="space-y-4">
              {ticketTypes.map((ticket) => (
                <Card key={ticket.id} className={cn("overflow-hidden transition-all", ticket.quantity > 0 ? "border-primary" : "border-gray-200")}>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-medium text-lg">{ticket.name}</h4>
                        <p className="text-gray-500">{ticket.description}</p>
                        <p className="text-sm mt-1">
                          {ticket.available === null ? "Unlimited availability" : `${ticket.available} available`}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-lg">
                          {ticket.priceCents === 0 ? "Free" : `$${(ticket.priceCents / 100).toFixed(2)}`}
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => handleQuantityChange(ticket.id, -1)} disabled={ticket.quantity === 0}>
                            <Minus className="h-4 w-4" />
                          </Button>
                          <span className="w-6 text-center font-medium">{ticket.quantity}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full"
                            onClick={() => handleQuantityChange(ticket.id, 1)}
                            disabled={ticket.available !== null && ticket.quantity >= ticket.available}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Payment Method</h2>
            <RadioGroup value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as "card" | "wallet")} className="space-y-2">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="wallet" id="wallet" />
                <Label htmlFor="wallet" className="flex items-center gap-2">
                  <Wallet className="h-4 w-4" />
                  Wallet
                  {walletBalance ? <span className="text-xs text-muted-foreground">(${walletBalance.balanceDollars.toFixed(2)} available)</span> : null}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="card" id="card" />
                <Label htmlFor="card" className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4" />
                  Card
                </Label>
              </div>
            </RadioGroup>
            {/* Conditional warning for insufficient wallet funds under wallet payment mode. */}
            {paymentMethod === "wallet" && walletInsufficient ? (
              <p className="text-sm text-red-600 mt-2">
                Insufficient balance. Need ${(finalTotalCents / 100).toFixed(2)}, available ${walletBalance?.balanceDollars.toFixed(2) || "0.00"}.
              </p>
            ) : null}
          </div>

          <div className="sticky bottom-0 bg-background pt-4 border-t">
            <div className="space-y-1 mb-4 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>${(subtotalCents / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Platform Fee</span>
                <span>${(((feeBreakdown?.platformFeeCents ?? 0) + (feeBreakdown?.paymentFeeCents ?? 0)) / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Sales Tax</span>
                <span>${((feeBreakdown?.salesTaxCents ?? 0) / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold text-base">
                <span>Total</span>
                <span>${(finalTotalCents / 100).toFixed(2)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {totalTickets} {totalTickets === 1 ? "ticket" : "tickets"}
              </div>
            </div>
            <Button
              onClick={handleCheckout}
              disabled={totalTickets === 0 || isSubmitting || (paymentMethod === "wallet" && walletInsufficient)}
              className="w-full px-8 py-6 text-lg font-medium bg-primary hover:bg-primary/90"
            >
              {isSubmitting ? "Processing..." : "Register"}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
