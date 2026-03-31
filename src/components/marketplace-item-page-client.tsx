/**
 * Client-rendered marketplace listing detail body.
 */
"use client"

import { useEffect, useState, use } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Image from "next/image"
import Link from "next/link"
import { ChevronLeft, MessageCircle, Share2, Bookmark, MapPin, Calendar, Heart } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { RelativeTime } from "@/components/relative-time"
import { fetchAgentsByIds, fetchMarketplaceListingById, fetchMySavedListingIds } from "@/app/actions/graph"
import type { SerializedResource, SerializedAgent } from "@/lib/graph-serializers"
import { resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { fetchVoucherEscrowStateAction, redeemVoucherAction, toggleSaveListing, createBookingAction, getOfferingBookingsAction, type VoucherEscrowState } from "@/app/actions/interactions"
import { updateResource } from "@/app/actions/create-resources"
import { CreateOfferingModal } from "@/components/create-offering-modal"
import type { OfferingDraftPayload, SelectedAgent } from "@/components/create-offering-form"
import { BookingWeekScheduler } from "@/components/booking-week-scheduler"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { formatMarketplaceListingTypeLabel, getMarketplacePrimaryActionLabel } from "@/lib/listing-types"
import { ListingActions } from "@/components/listing-actions"
import { ProvideModule } from "@/components/provide-module"

/**
 * Client-rendered page component for a single marketplace listing.
 *
 * Uses a two-tier data resolution strategy:
 * 1. Checks the SWR-cached marketplace feed for instant hydration.
 * 2. Falls back to fetching the listing individually from the server.
 *
 * @param params - Promise-based dynamic route params (`{ id }`) supplied by the App Router.
 * @returns Marketplace listing detail view with seller info and purchase actions.
 */
export function MarketplaceItemPageClient({
  params,
  initialResource,
  initialOwner,
}: {
  params: Promise<{ id: string }>
  initialResource: SerializedResource
  initialOwner?: SerializedAgent
}) {
  // Unwrap the async route params using React's `use()` hook.
  const resolvedParams = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()
  const dealPostId = searchParams.get("dealPostId")
  const dealPriceCents = searchParams.get("dealPriceCents")
  const purchaseHref = dealPostId
    ? `/marketplace/${resolvedParams.id}/purchase?dealPostId=${encodeURIComponent(dealPostId)}${dealPriceCents ? `&dealPriceCents=${encodeURIComponent(dealPriceCents)}` : ""}`
    : `/marketplace/${resolvedParams.id}/purchase`
  const [isSaved, setIsSaved] = useState(false)
  const [listing, setListing] = useState(() => resourceToMarketplaceListing(initialResource, initialOwner))
  const [detailResource, setDetailResource] = useState<SerializedResource>(initialResource)
  const [detailOwner, setDetailOwner] = useState<SerializedAgent | undefined>(initialOwner)
  const [savePending, setSavePending] = useState(false)
  const [isEditOfferingOpen, setIsEditOfferingOpen] = useState(false)
  const [targetAgents, setTargetAgents] = useState<SelectedAgent[]>([])
  const [selectedBookingDate, setSelectedBookingDate] = useState("")
  const [selectedBookingSlot, setSelectedBookingSlot] = useState("")
  const [voucherEscrowState, setVoucherEscrowState] = useState<VoucherEscrowState | null>(null)
  const [voucherActionPending, setVoucherActionPending] = useState(false)
  const { toast } = useToast()
  const { currentUser } = useUser()

  useEffect(() => {
    // Only fetch saved status when logged in — server action requires auth
    if (!currentUser?.id) {
      setIsSaved(false)
      return
    }
    let cancelled = false
    fetchMySavedListingIds()
      .then((ids) => {
        if (cancelled) return
        setIsSaved(ids.includes(resolvedParams.id))
      })
      .catch(() => {
        if (!cancelled) setIsSaved(false)
      })

    return () => {
      cancelled = true
    }
  }, [resolvedParams.id, currentUser?.id])

  useEffect(() => {
    const metadata = (detailResource.metadata ?? {}) as Record<string, unknown>
    const scopedIds = [
      ...((Array.isArray(metadata.scopedGroupIds) ? metadata.scopedGroupIds : []) as string[]),
      ...((Array.isArray(metadata.scopedUserIds) ? metadata.scopedUserIds : []) as string[]),
    ].filter((value): value is string => typeof value === "string" && value.length > 0)

    if (scopedIds.length === 0) {
      setTargetAgents([])
      return
    }

    let cancelled = false
    // fetchAgentsByIds requires auth; skip for anonymous users
    if (!currentUser?.id) {
      setTargetAgents([])
      return
    }
    fetchAgentsByIds(Array.from(new Set(scopedIds)))
      .then((agents) => {
        if (cancelled) return
        setTargetAgents(
          agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            type: agent.type,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setTargetAgents([])
      })

    return () => {
      cancelled = true
    }
  }, [detailResource, currentUser?.id])

  useEffect(() => {
    if (listing?.type !== "voucher" || !currentUser?.id) {
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
  }, [currentUser?.id, listing?.type, resolvedParams.id])

  const metadata = (detailResource.metadata ?? {}) as Record<string, unknown>
  const canEditOffering = Boolean(currentUser?.id && currentUser.id === detailResource.ownerId)
  const offeringInitialValues: Partial<OfferingDraftPayload> & { targetAgents?: SelectedAgent[] } = {
    title: detailResource.name,
    description: detailResource.description ?? detailResource.content ?? "",
    imageUrl:
      typeof metadata.imageUrl === "string"
        ? metadata.imageUrl
        : Array.isArray(metadata.images) && typeof metadata.images[0] === "string"
          ? metadata.images[0]
          : undefined,
    offeringType:
      typeof metadata.offeringType === "string"
        ? metadata.offeringType
        : typeof metadata.listingType === "string"
          ? metadata.listingType
          : listing?.type,
    basePrice:
      typeof metadata.basePrice === "number"
        ? metadata.basePrice
        : typeof metadata.totalPriceCents === "number"
          ? metadata.totalPriceCents
          : undefined,
    currency: typeof metadata.currency === "string" ? metadata.currency : listing?.currency,
    acceptedCurrencies: Array.isArray(metadata.acceptedCurrencies)
      ? metadata.acceptedCurrencies.filter((value): value is string => typeof value === "string")
      : listing?.acceptedCurrencies,
    quantityAvailable: typeof metadata.quantityAvailable === "number" ? metadata.quantityAvailable : undefined,
    tags: Array.isArray(metadata.tags)
      ? metadata.tags.filter((value): value is string => typeof value === "string")
      : undefined,
    voucherValues:
      metadata.voucherValues && typeof metadata.voucherValues === "object" && !Array.isArray(metadata.voucherValues)
        ? (metadata.voucherValues as OfferingDraftPayload["voucherValues"])
        : undefined,
    hourlyRate: typeof metadata.hourlyRate === "number" ? metadata.hourlyRate : undefined,
    estimatedDuration:
      metadata.estimatedDuration && typeof metadata.estimatedDuration === "object" && !Array.isArray(metadata.estimatedDuration)
        ? (metadata.estimatedDuration as OfferingDraftPayload["estimatedDuration"])
        : undefined,
    availability: typeof metadata.availability === "string" ? metadata.availability : undefined,
    bookingDates: Array.isArray(metadata.bookingDates)
      ? (metadata.bookingDates as OfferingDraftPayload["bookingDates"])
      : undefined,
    category: typeof metadata.category === "string" ? metadata.category : undefined,
    condition:
      typeof metadata.condition === "string"
        ? metadata.condition
        : typeof metadata.resourceCondition === "string"
          ? metadata.resourceCondition
          : undefined,
    bountyReward: typeof metadata.bountyReward === "number" ? metadata.bountyReward : undefined,
    bountyCriteria: typeof metadata.bountyCriteria === "string" ? metadata.bountyCriteria : undefined,
    bountyDeadline: typeof metadata.bountyDeadline === "string" ? metadata.bountyDeadline : undefined,
    ticketEventName: typeof metadata.ticketEventName === "string" ? metadata.ticketEventName : undefined,
    ticketDate: typeof metadata.ticketDate === "string" ? metadata.ticketDate : undefined,
    ticketVenue: typeof metadata.ticketVenue === "string" ? metadata.ticketVenue : undefined,
    ticketQuantity: typeof metadata.ticketQuantity === "number" ? metadata.ticketQuantity : undefined,
    ticketPrice: typeof metadata.ticketPrice === "number" ? metadata.ticketPrice : undefined,
    tripOrigin: typeof metadata.tripOrigin === "string" ? metadata.tripOrigin : undefined,
    tripDestination: typeof metadata.tripDestination === "string" ? metadata.tripDestination : undefined,
    tripDate: typeof metadata.tripDate === "string" ? metadata.tripDate : undefined,
    tripCapacity: typeof metadata.tripCapacity === "number" ? metadata.tripCapacity : undefined,
    skillArea: typeof metadata.skillArea === "string" ? metadata.skillArea : undefined,
    skillProficiency: typeof metadata.skillProficiency === "string" ? metadata.skillProficiency : undefined,
    skillRate: typeof metadata.skillRate === "number" ? metadata.skillRate : undefined,
    resourceCategory: typeof metadata.resourceCategory === "string" ? metadata.resourceCategory : undefined,
    resourceAvailability: typeof metadata.resourceAvailability === "string" ? metadata.resourceAvailability : undefined,
    resourceCondition: typeof metadata.resourceCondition === "string" ? metadata.resourceCondition : undefined,
    resourcePrice: typeof metadata.resourcePrice === "number" ? metadata.resourcePrice : undefined,
    dataFormat: typeof metadata.dataFormat === "string" ? metadata.dataFormat : undefined,
    dataSize: typeof metadata.dataSize === "string" ? metadata.dataSize : undefined,
    dataPrice: typeof metadata.dataPrice === "number" ? metadata.dataPrice : undefined,
    ownerId: detailResource.ownerId === currentUser?.id ? "self" : detailResource.ownerId,
    scopedLocaleIds: Array.isArray(metadata.scopedLocaleIds)
      ? metadata.scopedLocaleIds.filter((value): value is string => typeof value === "string")
      : undefined,
    scopedGroupIds: Array.isArray(metadata.scopedGroupIds)
      ? metadata.scopedGroupIds.filter((value): value is string => typeof value === "string")
      : undefined,
    scopedUserIds: Array.isArray(metadata.scopedUserIds)
      ? metadata.scopedUserIds.filter((value): value is string => typeof value === "string")
      : undefined,
    targetAgents,
    postToFeed: false,
  }

  const handleUpdateOffering = async (payload: OfferingDraftPayload) => {
    const totalPriceCents =
      typeof payload.basePrice === "number"
        ? payload.basePrice
        : Array.isArray(payload.items)
          ? payload.items.reduce((sum, item) => sum + (item.priceCents ?? 0), 0)
          : 0

    const quantitySold =
      typeof metadata.quantitySold === "number" && Number.isFinite(metadata.quantitySold) ? metadata.quantitySold : 0
    const quantityAvailable =
      typeof payload.quantityAvailable === "number" ? payload.quantityAvailable : null
    const nextQuantityRemaining =
      quantityAvailable == null ? null : Math.max(quantityAvailable - quantitySold, 0)

    const nextMetadata: Record<string, unknown> = {
      ...metadata,
      entityType: "offering",
      resourceKind: "offering",
      listingType: payload.offeringType ?? metadata.listingType ?? listing?.type ?? "product",
      offeringType: payload.offeringType ?? metadata.offeringType ?? listing?.type ?? "product",
      imageUrl: payload.imageUrl ?? null,
      images: payload.imageUrl ? [payload.imageUrl] : [],
      totalPriceCents,
      price: totalPriceCents > 0 ? `$${(totalPriceCents / 100).toFixed(2)}` : "Free",
      basePrice: payload.basePrice ?? null,
      currency: payload.currency ?? "USD",
      acceptedCurrencies: payload.acceptedCurrencies ?? [],
      quantityAvailable,
      quantitySold,
      quantityRemaining: nextQuantityRemaining,
      tags: payload.tags ?? [],
      voucherValues: payload.voucherValues ?? null,
      hourlyRate: payload.hourlyRate ?? null,
      estimatedDuration: payload.estimatedDuration ?? null,
      availability: payload.availability ?? null,
      bookingDates: payload.bookingDates ?? [],
      category: payload.category ?? null,
      condition: payload.condition ?? null,
      bountyReward: payload.bountyReward ?? null,
      bountyCriteria: payload.bountyCriteria ?? null,
      bountyDeadline: payload.bountyDeadline ?? null,
      ticketEventName: payload.ticketEventName ?? null,
      ticketDate: payload.ticketDate ?? null,
      ticketVenue: payload.ticketVenue ?? null,
      ticketQuantity: payload.ticketQuantity ?? null,
      ticketPrice: payload.ticketPrice ?? null,
      tripOrigin: payload.tripOrigin ?? null,
      tripDestination: payload.tripDestination ?? null,
      tripDate: payload.tripDate ?? null,
      tripCapacity: payload.tripCapacity ?? null,
      skillArea: payload.skillArea ?? null,
      skillProficiency: payload.skillProficiency ?? null,
      skillRate: payload.skillRate ?? null,
      resourceCategory: payload.resourceCategory ?? null,
      resourceAvailability: payload.resourceAvailability ?? null,
      resourceCondition: payload.resourceCondition ?? null,
      resourcePrice: payload.resourcePrice ?? null,
      dataFormat: payload.dataFormat ?? null,
      dataSize: payload.dataSize ?? null,
      dataPrice: payload.dataPrice ?? null,
      scopedLocaleIds: payload.scopedLocaleIds ?? [],
      scopedGroupIds: payload.scopedGroupIds ?? [],
      scopedUserIds: payload.scopedUserIds ?? [],
      chapterTags: payload.scopedLocaleIds ?? [],
      groupTags: payload.scopedGroupIds ?? [],
      groupId: payload.scopedGroupIds?.[0] ?? null,
    }

    const hasScopedLocales = (payload.scopedLocaleIds?.length ?? 0) > 0
    const hasScopedGroups = (payload.scopedGroupIds?.length ?? 0) > 0
    const hasScopedUsers = (payload.scopedUserIds?.length ?? 0) > 0
    const visibility = hasScopedGroups || hasScopedUsers ? "private" : hasScopedLocales ? "locale" : "public"
    const tags = Array.from(
      new Set([
        ...(payload.tags ?? []),
        ...(payload.scopedLocaleIds ?? []),
        ...(payload.scopedGroupIds ?? []),
        ...(payload.scopedUserIds ?? []),
      ]),
    )

    const result = await updateResource({
      resourceId: detailResource.id,
      ownerId: payload.ownerId,
      name: payload.title.trim(),
      description: payload.description.trim(),
      content: payload.description.trim(),
      tags,
      visibility,
      metadataPatch: nextMetadata,
    })

    if (!result.success) {
      throw new Error(result.message)
    }

    const refreshed = await fetchMarketplaceListingById(resolvedParams.id)
    if (refreshed) {
      setDetailResource(refreshed.resource as SerializedResource)
      setDetailOwner(refreshed.owner as SerializedAgent | undefined)
      setListing(
        resourceToMarketplaceListing(
          refreshed.resource as SerializedResource,
          refreshed.owner as SerializedAgent | undefined,
        ),
      )
    }
    setIsEditOfferingOpen(false)
    toast({ title: "Offering updated" })
    router.refresh()
  }

  /**
   * Optimistically toggles the save/bookmark state and syncs with the server.
   * Reverts on failure to maintain consistency.
   */
  const handleSaveToggle = async () => {
    setSavePending(true)
    const next = !isSaved
    setIsSaved(next)
    try {
      const result = await toggleSaveListing(resolvedParams.id)
      if (!result.success) {
        setIsSaved(!next)
      }
    } finally {
      setSavePending(false)
    }
  }

  const bookingDates = listing?.serviceDetails?.bookingDates ?? []
  const hasBookableSchedule = bookingDates.length > 0
  const bookingBlockMinutes = listing?.serviceDetails?.durationMinutes ?? 60
  const selectedBookingEntry = bookingDates.find((entry) => entry.date === selectedBookingDate) ?? null
  const bookingAwarePurchaseHref =
    hasBookableSchedule && selectedBookingDate && selectedBookingSlot
      ? `${purchaseHref}${purchaseHref.includes("?") ? "&" : "?"}bookingDate=${encodeURIComponent(selectedBookingDate)}&bookingSlot=${encodeURIComponent(selectedBookingSlot)}`
      : purchaseHref

  useEffect(() => {
    if (!listing) return
    if (!hasBookableSchedule) return
    if (!selectedBookingDate && bookingDates[0]) {
      setSelectedBookingDate(bookingDates[0].date)
      setSelectedBookingSlot(bookingDates[0].timeSlots[0] ?? "")
      return
    }

    const entry = bookingDates.find((booking) => booking.date === selectedBookingDate)
    if (!entry) {
      setSelectedBookingDate(bookingDates[0]?.date ?? "")
      setSelectedBookingSlot(bookingDates[0]?.timeSlots[0] ?? "")
      return
    }

    if (!entry.timeSlots.includes(selectedBookingSlot)) {
      setSelectedBookingSlot(entry.timeSlots[0] ?? "")
    }
  }, [bookingDates, hasBookableSchedule, listing, selectedBookingDate, selectedBookingSlot])

  if (!listing) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <Button variant="ghost" className="mb-4" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5 mr-1" />Back
        </Button>
        <p className="text-sm text-muted-foreground">Listing not found.</p>
      </div>
    )
  }

  const seller = detailOwner
    ? {
        id: detailOwner.id,
        name: detailOwner.name,
        username: (detailOwner.metadata?.username as string) || listing.seller.username,
        avatar: detailOwner.image || listing.seller.avatar,
      }
    : listing.seller
  const ownerHref = listing.ownerPath || `/profile/${seller.username || seller.id}`
  const ownerHeading = listing.ownerKind === "group" ? "Owner" : "Seller"
  const primaryActionLabel =
    listing.type === "voucher"
      ? voucherEscrowState?.status === "completed"
        ? "Voucher Redeemed"
        : voucherEscrowState?.hasEscrowClaim
          ? "Redeem Voucher"
          : "Claim Voucher"
      : getMarketplacePrimaryActionLabel(listing.type, hasBookableSchedule)

  const handlePrimaryAction = async () => {
    if (listing.type !== "voucher") {
      router.push(bookingAwarePurchaseHref)
      return
    }

    if (voucherEscrowState?.status === "completed") {
      return
    }

    if (!currentUser?.id) {
      router.push(bookingAwarePurchaseHref)
      return
    }

    if (voucherEscrowState?.canRedeem) {
      setVoucherActionPending(true)
      try {
        const result = await redeemVoucherAction(resolvedParams.id)
        if (!result.success) {
          toast({ title: "Unable to redeem voucher", description: result.message, variant: "destructive" })
          return
        }
        toast({ title: "Voucher redeemed", description: result.message })
        const state = await fetchVoucherEscrowStateAction(resolvedParams.id)
        setVoucherEscrowState(state)
      } finally {
        setVoucherActionPending(false)
      }
      return
    }

    router.push(bookingAwarePurchaseHref)
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 pb-20">
      <Button variant="ghost" className="mb-4 -ml-2 flex items-center" onClick={() => router.back()}>
        <ChevronLeft className="h-5 w-5 mr-1" />Back to Mart
      </Button>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-4">
          <div className="relative aspect-square rounded-lg overflow-hidden border">
            <Image src={getPrimaryListingImage(listing)} alt={listing.title} fill className="object-cover" />
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <div className="flex justify-between items-start">
              <h1 className="text-3xl font-bold">{listing.title}</h1>
              <Badge variant={listing.type === "product" ? "default" : "secondary"} className="text-sm">
                {formatMarketplaceListingTypeLabel(listing.type)}
              </Badge>
            </div>
            <div className="text-2xl font-bold mt-2">
              {typeof listing.thanksValue === "number" && listing.thanksValue > 0 ? (
                <span className="inline-flex items-center gap-2">
                  <Heart className="h-5 w-5 text-pink-500" />
                  <span>{listing.thanksValue} Thanks</span>
                </span>
              ) : listing.price === "Free" ? "Free" : `${listing.price}${listing.type === "service" && !listing.price.includes("/hr") ? "/hr" : ""}`}
            </div>
          </div>

          <div className="flex items-center text-sm text-muted-foreground">
            <Calendar className="h-4 w-4 mr-1" />
            <span>Listed <RelativeTime date={listing.createdAt} /></span>
            <span className="mx-2">•</span>
            <MapPin className="h-4 w-4 mr-1" />
            <span>{listing.location || "Unknown location"}</span>
          </div>

          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
            <p className="mt-1">{listing.description}</p>
          </div>

          {hasBookableSchedule ? (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium text-muted-foreground">Bookable Schedule</h3>
              <div className="mt-3 overflow-x-auto">
                <BookingWeekScheduler
                  bookingDates={bookingDates}
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
                  emptyLabel="No redeemable booking blocks are available in this week."
                />
              </div>
              {selectedBookingEntry && selectedBookingSlot ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Selected window: {new Date(`${selectedBookingDate}T00:00:00`).toLocaleDateString()} at {selectedBookingSlot}
                </p>
              ) : null}
              {voucherEscrowState?.hasEscrowClaim &&
              voucherEscrowState.claimedBookingDate &&
              voucherEscrowState.claimedBookingSlot ? (
                <p className="mt-2 text-xs text-emerald-300">
                  Reserved for you: {new Date(`${voucherEscrowState.claimedBookingDate}T00:00:00`).toLocaleDateString()} at{" "}
                  {voucherEscrowState.claimedBookingSlot}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="pt-4 border-t">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">{ownerHeading}</h3>
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {listing.ownerLabel || "Member offer"}
              </Badge>
            </div>
            <Link href={ownerHref} className="flex items-center">
              <Avatar className="h-10 w-10 mr-3">
                <AvatarImage src={seller.avatar || "/placeholder.svg"} alt={seller.name} />
                <AvatarFallback>{seller.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{seller.name}</p>
                <p className="text-sm text-muted-foreground">@{seller.username}</p>
              </div>
            </Link>
            <div className="mt-3 flex items-center gap-2">
              {canEditOffering ? (
                <Button variant="outline" size="sm" onClick={() => setIsEditOfferingOpen(true)}>
                  Edit Details
                </Button>
              ) : null}
              <ListingActions
                listingId={resolvedParams.id}
                listingTitle={listing.title}
                listingDescription={listing.description}
                listingPrice={listing.price}
                ownerId={detailResource.ownerId ?? ""}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-4">
            <Button
              onClick={() => void handlePrimaryAction()}
              size="lg"
              className="w-full"
              disabled={voucherActionPending || (listing.type === "voucher" && voucherEscrowState?.status === "completed")}
            >
              {voucherActionPending ? "Processing..." : primaryActionLabel}
            </Button>
            {listing.type !== "voucher" && listing.price !== "Free" && (() => {
              const priceCents = Math.round(parseFloat(listing.price.replace(/[^0-9.-]/g, "") || "0") * 100)
              if (priceCents <= 0) return null
              return (
                <ProvideModule
                  offeringId={listing.id}
                  sellerId={seller.id}
                  sellerName={seller.name}
                  items={[{ name: listing.title, priceCents, term: listing.type || "product" }]}
                  triggerButton={
                    <Button variant="outline" size="lg" className="w-full">
                      Pay In Person (Apple Pay / Google Pay)
                    </Button>
                  }
                />
              )
            })()}
            {listing.type === "voucher" && voucherEscrowState ? (
              <p className="text-sm text-muted-foreground">
                {voucherEscrowState.status === "completed"
                  ? "This voucher has already been redeemed."
                  : voucherEscrowState.hasEscrowClaim
                  ? `You have ${voucherEscrowState.escrowedTokenCount} Thanks escrowed for this voucher.`
                  : voucherEscrowState.requiredThanks > 0
                    ? `Claiming this voucher escrows ${voucherEscrowState.requiredThanks} Thanks until redemption.`
                    : "This voucher can be claimed without Thanks escrow."}
              </p>
            ) : null}
            <div className="grid grid-cols-3 gap-3">
              <Button
                variant="outline"
                className="flex items-center justify-center"
                onClick={() => router.push(`/messages?user=${seller.id}`)}
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Contact
              </Button>
              <Button variant="outline" onClick={() => void handleSaveToggle()} disabled={savePending} className={isSaved ? "text-primary" : ""}><Bookmark className="h-4 w-4 mr-2" />{isSaved ? "Saved" : "Save"}</Button>
              <Button variant="outline" onClick={() => navigator.clipboard.writeText(window.location.href)}><Share2 className="h-4 w-4 mr-2" />Share</Button>
            </div>
          </div>
        </div>
      </div>
      <CreateOfferingModal
        open={isEditOfferingOpen}
        onClose={() => setIsEditOfferingOpen(false)}
        title="Edit Offering"
        description="Update the full offering profile from the canonical offering editor."
        initialValues={offeringInitialValues}
        onSubmitPayload={handleUpdateOffering}
      />
    </div>
  )
}
