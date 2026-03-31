"use client"

import { useState, useEffect, useMemo } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useSession } from "next-auth/react"
import Image from "next/image"
import { ChevronLeft, Minus, Plus, ArrowRight, Heart } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useToast } from "@/components/ui/use-toast"
import { purchaseWithWalletAction, getMyWalletAction, recordEthPaymentAction, getAgentEthAddressAction } from "@/app/actions/wallet"
import type { WalletBalance } from "@/types"
import { useMarketplace } from "@/lib/hooks/use-graph-data"
import { fetchMarketplaceListingById } from "@/app/actions/graph"
import type { SerializedResource, SerializedAgent } from "@/lib/graph-serializers"
import { resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { AuthModal } from "@/components/auth-modal"
import { BookingWeekScheduler } from "@/components/booking-week-scheduler"
import { PaymentMethodSelector, type PaymentMethod } from "@/components/payment-method-selector"
import { executeSplitCryptoPayment, ensureBaseNetwork, connectMetaMask } from "@/lib/metamask"
import { calculateCheckoutFees } from "@/lib/checkout-fees"
import { MARKETPLACE_FEE_BPS, BPS_DIVISOR } from "@/lib/wallet-constants"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { getMarketplacePrimaryActionLabel } from "@/lib/listing-types"
import { claimVoucherWithThanksEscrowAction, fetchVoucherEscrowStateAction, type VoucherEscrowState } from "@/app/actions/interactions"


export function PurchasePageClient({ id }: { id: string }) {
  const resolvedParams = { id }
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { data: session, update: updateSession } = useSession()
  const { listings } = useMarketplace(1000)

  const [fallbackListing, setFallbackListing] = useState<ReturnType<typeof resourceToMarketplaceListing> | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [loadingFallback, setLoadingFallback] = useState(true)
  const listing = useMemo(
    () => fallbackListing || listings.find((entry) => entry.id === resolvedParams.id) || null,
    [fallbackListing, listings, resolvedParams.id]
  )
  const seller = listing?.seller

  const [quantity, setQuantity] = useState(1)
  const [selectedBookingDate, setSelectedBookingDate] = useState(searchParams.get("bookingDate") || "")
  const [selectedBookingSlot, setSelectedBookingSlot] = useState(searchParams.get("bookingSlot") || "")
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card")
  const [isProcessing, setIsProcessing] = useState(false)
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [sellerEthAddress, setSellerEthAddress] = useState<string | null>(null)
  const [voucherEscrowState, setVoucherEscrowState] = useState<VoucherEscrowState | null>(null)
  const dealPostId = searchParams.get("dealPostId")
  const requestedDealPriceCents = Number(searchParams.get("dealPriceCents") || "")

  // Fetch wallet balance for authenticated users.
  useEffect(() => {
    let cancelled = false

    async function loadWallet() {
      setWalletLoading(true)
      try {
        const result = await getMyWalletAction()
        if (!cancelled && result.success && result.wallet) {
          setWalletBalance(result.wallet)
        }
      } catch {
        // Wallet load failed silently; user can still use card.
      } finally {
        if (!cancelled) setWalletLoading(false)
      }
    }

    loadWallet()
    return () => { cancelled = true }
  }, [])

  // Fetch seller's ETH address for crypto payments.
  useEffect(() => {
    if (!seller?.id) return
    let cancelled = false
    getAgentEthAddressAction(seller.id).then(({ ethAddress }) => {
      if (!cancelled) setSellerEthAddress(ethAddress)
    })
    return () => { cancelled = true }
  }, [seller?.id])

  // Always fetch authoritative listing detail for purchase state such as payment readiness.
  useEffect(() => {
    let cancelled = false
    setLoadingFallback(true)

    fetchMarketplaceListingById(resolvedParams.id)
      .then((detail) => {
        if (cancelled || !detail) return
        setFallbackListing(resourceToMarketplaceListing(
          detail.resource as SerializedResource,
          detail.owner as SerializedAgent | undefined
        ))
      })
      .catch(() => {
        if (!cancelled) setFallbackListing(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingFallback(false)
      })

    return () => {
      cancelled = true
    }
  }, [resolvedParams.id])

  useEffect(() => {
    if (listing?.cardCheckoutAvailable === false && paymentMethod === "card") {
      if (walletBalance && walletBalance.balanceCents > 0) {
        setPaymentMethod("wallet")
        return
      }
      if (listing.currency === "USDC" || listing.currency === "ETH") {
        setPaymentMethod("crypto")
      }
    }
  }, [listing?.cardCheckoutAvailable, listing?.currency, paymentMethod, walletBalance])

  useEffect(() => {
    if (listing?.type !== "voucher" || !session?.user?.id) {
      setVoucherEscrowState(null)
      return
    }

    let cancelled = false
    fetchVoucherEscrowStateAction(resolvedParams.id)
      .then((state) => {
        if (!cancelled) setVoucherEscrowState(state)
      })
      .catch(() => {
        if (!cancelled) setVoucherEscrowState(null)
      })

    return () => {
      cancelled = true
    }
  }, [listing?.type, resolvedParams.id, session?.user?.id])

  // Derived values — safe to compute even when listing is null
  const maxSelectableQuantity =
    listing && typeof listing.quantityRemaining === "number" ? Math.max(listing.quantityRemaining, 0) : null
  const bookableSchedule = listing?.serviceDetails?.bookingDates ?? []
  const hasBookableSchedule = bookableSchedule.length > 0
  const bookingBlockMinutes = listing?.serviceDetails?.durationMinutes ?? 60
  const selectedBookingEntry =
    bookableSchedule.find((entry) => entry.date === selectedBookingDate) ?? null
  const selectedBookingIsValid = Boolean(
    selectedBookingDate &&
      selectedBookingSlot &&
      bookableSchedule.some(
        (entry) => entry.date === selectedBookingDate && entry.timeSlots.includes(selectedBookingSlot),
      ),
  )

  // These hooks MUST be before any conditional return to avoid React #310
  useEffect(() => {
    if (maxSelectableQuantity != null && maxSelectableQuantity > 0 && quantity > maxSelectableQuantity) {
      setQuantity(maxSelectableQuantity)
    }
  }, [maxSelectableQuantity, quantity])

  useEffect(() => {
    if (!hasBookableSchedule) return

    if (!selectedBookingDate && bookableSchedule[0]) {
      setSelectedBookingDate(bookableSchedule[0].date)
      setSelectedBookingSlot(bookableSchedule[0].timeSlots[0] ?? "")
      return
    }

    const entry = bookableSchedule.find((booking) => booking.date === selectedBookingDate)
    if (!entry) {
      setSelectedBookingDate(bookableSchedule[0]?.date ?? "")
      setSelectedBookingSlot(bookableSchedule[0]?.timeSlots[0] ?? "")
      return
    }

    if (!entry.timeSlots.includes(selectedBookingSlot)) {
      setSelectedBookingSlot(entry.timeSlots[0] ?? "")
    }
  }, [bookableSchedule, hasBookableSchedule, selectedBookingDate, selectedBookingSlot])

  if (!listing || !seller) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <Button variant="ghost" className="mb-4 -ml-2" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5 mr-1" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground">{loadingFallback ? "Loading listing..." : "Listing not found."}</p>
      </div>
    )
  }

  const orderSummarySuffix =
    listing.type === "product"
      ? `(${quantity})`
      : hasBookableSchedule
        ? selectedBookingIsValid
          ? `(${selectedBookingDate} ${selectedBookingSlot})`
          : "(select a booking window)"
        : listing.type === "service"
          ? `(${quantity} hr${quantity > 1 ? "s" : ""})`
          : ""

  /** Adjusts the quantity by a given delta, clamped to a minimum of 1. */
  const handleQuantityChange = (change: number) => {
    const cappedQuantity = maxSelectableQuantity != null
      ? Math.min(quantity + change, Math.max(maxSelectableQuantity, 1))
      : quantity + change
    const newQuantity = Math.max(1, cappedQuantity)
    setQuantity(newQuantity)
  }

  // Parse the listing price to a numeric value for calculations.
  const numericPrice = Number(String(listing.price).replace(/[^0-9.]/g, "")) || 0
  const dealPriceCents =
    dealPostId && Number.isFinite(requestedDealPriceCents) && requestedDealPriceCents > 0
      ? requestedDealPriceCents
      : null
  const effectiveUnitPrice = dealPriceCents ? dealPriceCents / 100 : numericPrice
  const totalPrice = effectiveUnitPrice * quantity
  const checkoutFees = calculateCheckoutFees(Math.round(totalPrice * 100))
  const walletPlatformFeeCents = listing.type === "product" ? checkoutFees.platformFeeCents : 0
  const cardPlatformFeeCents = checkoutFees.buyerPlatformFeeCents
  const displayedPlatformFeeCents =
    paymentMethod === "card" ? cardPlatformFeeCents : walletPlatformFeeCents
  const finalTotal =
    paymentMethod === "card"
      ? checkoutFees.buyerTotalCents / 100
      : (Math.round(totalPrice * 100) + walletPlatformFeeCents) / 100

  /** Processes card checkout via Stripe hosted page. */
  const handleCardCheckout = async () => {
    if (listing.cardCheckoutAvailable === false) {
      const message =
        listing.cardCheckoutUnavailableReason ||
        "Seller has not enabled card payments for this listing yet."
      setCheckoutError(message)
      toast({ title: "Card checkout unavailable", description: message, variant: "destructive" })
      return
    }

    try {
      setCheckoutError(null)
      const res = await fetch("/api/stripe/marketplace-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: resolvedParams.id,
          quantity,
          hours: listing.type === "service" ? quantity : undefined,
          buyerAgentId: session?.user?.id || null,
          dealPostId,
          bookingDate: selectedBookingDate || null,
          bookingSlot: selectedBookingSlot || null,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Checkout session creation failed.")
      }

      const { url } = await res.json()
      if (url) {
        window.location.href = url
      } else {
        throw new Error("No checkout URL returned.")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Card checkout failed."
      setCheckoutError(message)
      toast({ title: "Checkout error", description: message, variant: "destructive" })
    }
  }

  /** Processes wallet checkout via server action. */
  const handleWalletCheckout = async () => {
    const subtotalCents = Math.round(totalPrice * 100)

    if (walletBalance && walletBalance.balanceCents < Math.round(finalTotal * 100)) {
      setCheckoutError(`Your wallet has $${walletBalance.balanceDollars.toFixed(2)} but this purchase requires $${finalTotal.toFixed(2)}.`)
      toast({
        title: "Insufficient balance",
        description: `Your wallet has $${walletBalance.balanceDollars.toFixed(2)} but this purchase requires $${finalTotal.toFixed(2)}.`,
        variant: "destructive",
      })
      return
    }

    const result = await purchaseWithWalletAction(
      resolvedParams.id,
      subtotalCents,
      dealPostId,
      selectedBookingDate || null,
      selectedBookingSlot || null,
    )

    if (!result.success) {
      setCheckoutError(result.error ?? "Unable to complete wallet purchase. Please try again.")
      toast({
        title: "Purchase failed",
        description: result.error ?? "Unable to complete wallet purchase. Please try again.",
        variant: "destructive",
      })
      return
    }

    router.push(
      result.receiptId
        ? `/marketplace/${resolvedParams.id}/receipt/${result.receiptId}`
        : `/marketplace/${resolvedParams.id}/confirmed`,
    )
  }

  /**
   * Processes crypto checkout via MetaMask on Base network.
   * Splits payment: seller receives net amount, platform receives fee.
   * For USDC listings: amounts are 1:1 USD.
   * For ETH listings: fetches live ETH price from CoinGecko.
   */
  const handleCryptoCheckout = async () => {
    if (!seller.id) {
      setCheckoutError("Seller information is missing.")
      toast({ title: "Error", description: "Seller information is missing.", variant: "destructive" })
      return
    }

    // Seller must have an ETH address on their profile
    if (!sellerEthAddress) {
      setCheckoutError("The seller hasn't set up a crypto wallet to receive payments.")
      toast({
        title: "Seller wallet missing",
        description: "The seller hasn't set up a crypto wallet to receive payments.",
        variant: "destructive",
      })
      return
    }

    const currency = listing.currency as "USDC" | "ETH"
    if (currency !== "USDC" && currency !== "ETH") {
      setCheckoutError("Listing currency not supported for crypto.")
      toast({ title: "Error", description: "Listing currency not supported for crypto.", variant: "destructive" })
      return
    }

    try {
      setCheckoutError(null)
      // Ensure MetaMask is connected and on Base
      await connectMetaMask()
      await ensureBaseNetwork()

      // Calculate fee split
      const totalCents = Math.round(finalTotal * 100)
      const platformFeeCents = Math.round((totalCents * MARKETPLACE_FEE_BPS) / BPS_DIVISOR)
      const sellerNetCents = totalCents - platformFeeCents
      const sellerAmountUsd = sellerNetCents / 100
      const platformFeeUsd = platformFeeCents / 100

      // For ETH payments, fetch live price
      let ethPriceUsd: number | undefined
      if (currency === "ETH") {
        try {
          const priceRes = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
          )
          const priceData = await priceRes.json()
          ethPriceUsd = priceData?.ethereum?.usd
          if (!ethPriceUsd) throw new Error("Could not fetch ETH price.")
        } catch {
          setCheckoutError("Could not fetch current ETH price. Try again.")
          toast({ title: "Price feed error", description: "Could not fetch current ETH price. Try again.", variant: "destructive" })
          return
        }
      }

      toast({ title: "Confirm in MetaMask", description: `Sending ${currency} to seller on Base network...` })

      const paymentResult = await executeSplitCryptoPayment(
        currency,
        sellerEthAddress,
        sellerAmountUsd,
        platformFeeUsd,
        ethPriceUsd
      )

      // Record both transactions on the backend
      const result = await recordEthPaymentAction(
        seller.id,
        totalCents,
        paymentResult.sellerTxHash,
        `Mart purchase: ${listing.title} (${paymentResult.sellerAmountFormatted} to seller, ${paymentResult.platformFeeFormatted} platform fee) [${paymentResult.platformFeeTxHash}]`,
        resolvedParams.id,
        paymentResult.platformFeeTxHash
      )

      if (!result.success) {
        setCheckoutError(result.error ?? "Payment sent but recording failed. Contact support with your tx hashes.")
        toast({
          title: "Recording failed",
          description: result.error ?? "Payment sent but recording failed. Contact support with your tx hashes.",
          variant: "destructive",
        })
        return
      }

      router.push(
        result.receiptId
          ? `/marketplace/${resolvedParams.id}/receipt/${result.receiptId}`
          : `/marketplace/${resolvedParams.id}/confirmed`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : "Crypto payment failed."
      setCheckoutError(message)
      toast({ title: "Payment error", description: message, variant: "destructive" })
    }
  }

  /**
   * Main checkout handler. Checks auth state, shows auth modal for
   * unauthenticated users, then dispatches to the appropriate payment handler.
   */
  const handleCheckout = async () => {
    if (hasBookableSchedule && !selectedBookingIsValid) {
      setCheckoutError("Select a booking window before checkout.")
      toast({
        title: "Booking window required",
        description: "Select an available date and time before purchasing.",
        variant: "destructive",
      })
      return
    }

    // For non-card methods, require authentication.
    if (!session?.user && paymentMethod !== "card") {
      setShowAuthModal(true)
      return
    }

    // Guest card checkout is supported by the API route and should go directly
    // to Stripe rather than forcing a modal detour.
    if (!session?.user && paymentMethod === "card") {
      setIsProcessing(true)
      try {
        await handleCardCheckout()
      } finally {
        setIsProcessing(false)
      }
      return
    }

    await executeCheckout()
  }

  /** Dispatches to the correct payment handler based on selected method. */
  const executeCheckout = async () => {
    setIsProcessing(true)

    try {
      setCheckoutError(null)
      switch (paymentMethod) {
        case "card":
          await handleCardCheckout()
          break
        case "wallet":
          await handleWalletCheckout()
          break
        case "crypto":
          await handleCryptoCheckout()
          break
      }
    } catch {
      toast({
        title: "Something went wrong",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  /** Called when user authenticates via the auth modal. */
  const handleAuthenticated = async () => {
    setShowAuthModal(false)
    await updateSession()
    // After session refresh, proceed with checkout.
    await executeCheckout()
  }

  /** Called when user chooses to continue as guest. */
  const handleGuestContinue = async () => {
    setShowAuthModal(false)
    // Guest flow always goes to card checkout (Stripe handles guest identity).
    setPaymentMethod("card")
    setIsProcessing(true)
    try {
      await handleCardCheckout()
    } finally {
      setIsProcessing(false)
    }
  }

  /** Crypto payment is only available when the seller marked USDC or ETH as the currency. */
  const listingAcceptsCrypto = listing.currency === "USDC" || listing.currency === "ETH"

  const renderPaymentMethodSelector = () => (
    <PaymentMethodSelector
      selected={paymentMethod}
      onChange={setPaymentMethod}
      cardAvailable={listing.cardCheckoutAvailable !== false}
      cardUnavailableReason={listing.cardCheckoutUnavailableReason}
      walletBalanceCents={walletBalance?.balanceCents}
      hasEthAddress={!!walletBalance?.ethAddress}
      isAuthenticated={!!session?.user}
      disabled={isProcessing}
      listingAcceptsCrypto={listingAcceptsCrypto}
      listingCurrency={listing.currency}
    />
  )

  if (listing.type === "voucher") {
    const requiredThanks = voucherEscrowState?.requiredThanks ?? listing.thanksValue ?? 0
    const availableThanks = voucherEscrowState?.availableThanks ?? walletBalance?.thanksTokenCount ?? 0
    const hasEscrowClaim = voucherEscrowState?.hasEscrowClaim ?? false

    const handleVoucherClaim = async () => {
      if (!session?.user) {
        setShowAuthModal(true)
        return
      }

      setIsProcessing(true)
      try {
        const result = await claimVoucherWithThanksEscrowAction(
          resolvedParams.id,
          hasBookableSchedule && selectedBookingIsValid
            ? { date: selectedBookingDate, slot: selectedBookingSlot }
            : null,
        )
        if (!result.success) {
          setCheckoutError(result.message)
          toast({ title: "Unable to claim voucher", description: result.message, variant: "destructive" })
          return
        }

        toast({ title: "Voucher claimed", description: result.message })
        router.push(`/marketplace/${resolvedParams.id}`)
      } finally {
        setIsProcessing(false)
      }
    }

    return (
      <div className="container max-w-3xl mx-auto px-4 py-8 pb-20">
        <Button variant="ghost" className="mb-4 -ml-2" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5 mr-1" />
          Back
        </Button>
        <div className="grid gap-6 md:grid-cols-[160px_1fr]">
          <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted/40">
            <Image src={getPrimaryListingImage(listing)} alt={listing.title} fill className="object-cover" />
          </div>
          <div className="space-y-4">
            <div>
              <Badge variant="outline" className="mb-2">{getMarketplacePrimaryActionLabel(listing.type, false)}</Badge>
              <h1 className="text-2xl font-bold">{listing.title}</h1>
              <p className="mt-2 text-muted-foreground">{listing.description}</p>
            </div>
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Escrow required</span>
                  <span className="inline-flex items-center gap-2 text-lg font-semibold">
                    <Heart className="h-5 w-5 text-pink-500" />
                    {requiredThanks} Thanks
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Your available Thanks</span>
                  <span className="font-medium">{availableThanks}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Claiming this voucher moves whole Thanks tokens into escrow. After the service is delivered, redeeming the voucher releases those escrowed Thanks to the offerer.
                </p>
                {hasBookableSchedule ? (
                  <div className="space-y-3 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Choose a redemption block</p>
                      <p className="text-xs text-muted-foreground">
                        Pick the week-view block when you expect to redeem this voucher.
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <BookingWeekScheduler
                        bookingDates={bookableSchedule}
                        blockDurationMinutes={bookingBlockMinutes}
                        selection={
                          selectedBookingDate && selectedBookingSlot
                            ? { date: selectedBookingDate, slot: selectedBookingSlot }
                            : null
                        }
                        onSelect={(next) => {
                          setSelectedBookingDate(next.date)
                          setSelectedBookingSlot(next.slot)
                        }}
                      />
                    </div>
                    {selectedBookingIsValid ? (
                      <p className="text-xs text-muted-foreground">
                        Selected block: {new Date(`${selectedBookingDate}T00:00:00`).toLocaleDateString()} at {selectedBookingSlot}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select one booking block before claiming.</p>
                    )}
                  </div>
                ) : null}
                {hasEscrowClaim ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                    You already have this voucher claimed and funded in escrow. Go back to the voucher page to redeem it once the service is complete.
                  </div>
                ) : voucherEscrowState?.status === "completed" ? (
                  <div className="rounded-lg border border-muted p-3 text-sm text-muted-foreground">
                    This voucher has already been redeemed.
                  </div>
                ) : null}
                {checkoutError ? (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {checkoutError}
                  </div>
                ) : null}
                <Button
                  size="lg"
                  className="w-full"
                  disabled={
                    isProcessing ||
                    hasEscrowClaim ||
                    voucherEscrowState?.status === "completed" ||
                    requiredThanks <= 0 ||
                    availableThanks < requiredThanks ||
                    (hasBookableSchedule && !selectedBookingIsValid)
                  }
                  onClick={() => void handleVoucherClaim()}
                >
                  {isProcessing ? "Escrowing Thanks..." : `Claim Voucher`}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
        <AuthModal
          open={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          onAuthenticated={() => void handleVoucherClaim()}
          onGuestContinue={() => setShowAuthModal(false)}
        />
      </div>
    )
  }

  return (
    <div
      className="min-h-screen bg-gradient-to-br flex flex-col md:flex-row"
      style={{ background: "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 50%, #1e3a8a 100%)" }}
    >
      {/* Left side - Item image */}
      <div className="w-full md:w-2/5 p-6 flex items-center justify-center">
        <div className="relative w-full max-w-md aspect-square rounded-xl overflow-hidden shadow-2xl">
          <Image
            src={getPrimaryListingImage(listing)}
            alt={listing.title}
            fill
            className="object-cover"
            priority
          />
        </div>
      </div>

      {/* Right side - Purchase form */}
      <div className="w-full md:w-3/5 bg-background p-8 md:p-12 min-h-screen overflow-y-auto">
        <div className="max-w-2xl">
          <Button variant="ghost" className="mb-6 -ml-2 flex items-center" onClick={() => router.back()}>
            <ChevronLeft className="h-5 w-5 mr-1" />
            Back to item
          </Button>

          {/* Item header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">{listing.title}</h1>
            <p className="text-muted-foreground">{listing.description}</p>

            {dealPriceCents ? (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Post deal applied. This checkout is using the linked offer price from the post.
              </div>
            ) : null}

            <div className="mt-4 flex items-center gap-2 flex-wrap text-sm">
              <Link href={listing.ownerPath || `/profile/${seller.username || seller.id}`} className="flex items-center">
                <Avatar className="h-6 w-6 mr-2">
                  <AvatarImage src={seller.avatar || "/placeholder.svg"} alt={seller.name} />
                  <AvatarFallback className="text-xs">{seller.name.charAt(0)}</AvatarFallback>
                </Avatar>
                <span>{seller.name}</span>
              </Link>
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {listing.ownerLabel || "Member offer"}
              </Badge>
            </div>

            {(listing.acceptedCurrencies?.length || maxSelectableQuantity != null) ? (
              <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
                {listing.acceptedCurrencies?.length ? (
                  <span className="rounded-full border px-3 py-1">
                    Accepts: {listing.acceptedCurrencies.join(", ")}
                  </span>
                ) : null}
                {maxSelectableQuantity != null ? (
                  <span className="rounded-full border px-3 py-1">
                    {maxSelectableQuantity > 0
                      ? `${maxSelectableQuantity} remaining`
                      : "Sold out"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Purchase options */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Purchase Details</h2>

            {listing.type === "product" && (
              <Card className="mb-4">
                <CardContent className="p-4">
                  <div className="flex justify-between items-center">
                    <div>
                      <h4 className="font-medium text-lg">Quantity</h4>
                      <p className="text-sm text-muted-foreground">How many would you like?</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 rounded-full"
                        onClick={() => handleQuantityChange(-1)}
                        disabled={quantity === 1}
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="w-6 text-center font-medium">{quantity}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 rounded-full"
                        onClick={() => handleQuantityChange(1)}
                        disabled={maxSelectableQuantity != null && quantity >= maxSelectableQuantity}
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {listing.type === "service" && (
              <Card className="mb-4">
                <CardContent className="p-4">
                  <div>
                    <h4 className="font-medium text-lg">Service Booking</h4>
                    {hasBookableSchedule ? (
                      <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                          Select the week-view block you want to book.
                        </p>
                        <div className="overflow-x-auto">
                          <BookingWeekScheduler
                            bookingDates={bookableSchedule}
                            blockDurationMinutes={bookingBlockMinutes}
                            selection={
                              selectedBookingDate && selectedBookingSlot
                                ? { date: selectedBookingDate, slot: selectedBookingSlot }
                                : null
                            }
                            onSelect={(next) => {
                              setSelectedBookingDate(next.date)
                              setSelectedBookingSlot(next.slot)
                            }}
                          />
                        </div>
                        {selectedBookingEntry && selectedBookingSlot ? (
                          <p className="text-xs text-muted-foreground">
                            Selected block: {new Date(`${selectedBookingDate}T00:00:00`).toLocaleDateString()} at {selectedBookingSlot}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Select one booking block to continue.</p>
                        )}
                      </div>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          You&apos;re booking this service at {listing.price}/hr for {quantity} hour{quantity > 1 ? "s" : ""}
                        </p>
                        <div className="flex items-center gap-3 mt-3">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full"
                            onClick={() => handleQuantityChange(-1)}
                            disabled={quantity === 1}
                            aria-label="Decrease hours"
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                          <span className="w-6 text-center font-medium">{quantity}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full"
                            onClick={() => handleQuantityChange(1)}
                            disabled={maxSelectableQuantity != null && quantity >= maxSelectableQuantity}
                            aria-label="Increase hours"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <h2 className="text-xl font-semibold mb-4">Payment Method</h2>
            {renderPaymentMethodSelector()}
            {checkoutError ? (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {checkoutError}
              </div>
            ) : null}
          </div>

          {/* Order summary */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Order Summary</h2>
            <div className="space-y-2 mb-4">
              <div className="flex justify-between">
                <span>
                  {listing.title} {orderSummarySuffix}
                </span>
                <span>
                  {dealPriceCents ? (
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground line-through">
                        ${(numericPrice * quantity).toFixed(2)}
                      </span>
                      <span>${(totalPrice).toFixed(2)}</span>
                    </span>
                  ) : (
                    `$${(numericPrice * quantity).toFixed(2)}`
                  )}
                </span>
              </div>

              {displayedPlatformFeeCents > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Platform fee</span>
                  <span>${(displayedPlatformFeeCents / 100).toFixed(2)}</span>
                </div>
              )}

              <div className="flex justify-between font-bold pt-2 border-t">
                <span>Total</span>
                <span>${finalTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Checkout button */}
          <div className="sticky bottom-0 bg-background pt-4 border-t">
            <Button
              onClick={handleCheckout}
              disabled={
                isProcessing ||
                maxSelectableQuantity === 0 ||
                (hasBookableSchedule && !selectedBookingIsValid) ||
                (paymentMethod === "card" && listing.cardCheckoutAvailable === false) ||
                (paymentMethod === "wallet" && (!walletBalance || walletBalance.balanceCents < Math.round(finalTotal * 100)))
              }
              className="w-full px-8 py-6 text-lg font-medium bg-primary hover:bg-primary/90"
            >
              {isProcessing ? "Processing..." : getMarketplacePrimaryActionLabel(listing.type, hasBookableSchedule)}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Auth modal for unauthenticated purchase attempts */}
      <AuthModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthenticated={handleAuthenticated}
        onGuestContinue={handleGuestContinue}
        context="Sign in to complete your purchase"
      />
    </div>
  )
}
