"use client"

import { useState } from "react"
import type { MarketplaceListing } from "@/lib/types"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Bookmark, Heart, MessageCircle, Share2 } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { formatMarketplaceListingTypeLabel } from "@/lib/listing-types"

/**
 * Marketplace feed UI for browsing product and service listings in the marketplace feature.
 * Used on marketplace listing/index pages where users filter listings, open listing detail pages,
 * and trigger save/contact/share actions.
 * Key props:
 * - `listings`: marketplace records to render.
 * - `getSeller`: resolver for seller display data.
 * - `onSave` / `onContact` / `onShare`: user interaction callbacks.
 * - `savedListings`: IDs used to render saved state.
 */
interface MarketplaceFeedProps {
  listings: MarketplaceListing[]
  getSeller: (sellerId: string) => { id: string; name: string; username: string; avatar: string }
  onSave: (listingId: string) => void
  onContact: (listingId: string) => void
  onShare: (listingId: string) => void
  savedListings?: string[]
}

/**
 * Renders a filterable feed of marketplace listings with card navigation and action buttons.
 *
 * @param props Component props containing listing data, seller resolver, and action handlers.
 */
export function MarketplaceFeed({
  listings,
  getSeller,
  onSave,
  onContact,
  onShare,
  savedListings = [],
}: MarketplaceFeedProps) {
  // Local UI state for the currently selected listing type filter.
  const [filter, setFilter] = useState<string>("all")
  const router = useRouter()

  const FILTER_OPTIONS = [
    { value: "all", label: "All" },
    { value: "product", label: "Products" },
    { value: "service", label: "Services" },
    { value: "voucher", label: "Vouchers" },
    { value: "ticket", label: "Tickets" },
    { value: "bounty", label: "Bounties" },
    { value: "gift", label: "Gifts" },
  ] as const

  // Derived collection that drives conditional empty-state vs card-grid rendering.
  const filteredListings = listings.filter((listing) => {
    if (filter === "all") return true
    return listing.type === filter
  })

  // Card click navigates to the listing detail page.
  const handleCardClick = (id: string) => {
    router.push(`/marketplace/${id}`)
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={filter === opt.value ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(opt.value)}
            className="shrink-0"
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {filteredListings.length === 0 ? (
        <div className="text-center py-10">
          <p className="text-muted-foreground">No listings found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredListings.map((listing) => {
            const seller = getSeller(listing.seller?.id ?? "")
            const isSaved = savedListings.includes(listing.id)

            return (
                <Card
                key={listing.id}
                className="overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => handleCardClick(listing.id)}
              >
                <div className="relative h-48 w-full">
                  {/* Conditional media rendering with a fallback placeholder when no listing image exists. */}
                  {listing.imageUrl || (listing.images && listing.images.length > 0) ? (
                    <Image
                      src={getPrimaryListingImage(listing)}
                      alt={listing.title}
                      fill
                      className="object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-muted flex items-center justify-center">
                      <p className="text-muted-foreground">No image</p>
                    </div>
                  )}
                  <Badge
                    className="absolute top-2 right-2 capitalize"
                    variant={listing.type === "product" ? "default" : "secondary"}
                  >
                    {formatMarketplaceListingTypeLabel(listing.type)}
                  </Badge>
                </div>

                <CardContent className="p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-lg line-clamp-1">{listing.title}</h3>
                      <div className="text-xl font-bold">
                        {typeof listing.thanksValue === "number" && listing.thanksValue > 0 ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Heart className="h-4 w-4 text-pink-500" />
                            <span>{listing.thanksValue} Thanks</span>
                          </span>
                        ) : listing.price === "Free" ? "Free" : (
                          <>
                            {listing.price}
                            {listing.type === "service" && !listing.price.includes("/hr") && "/hr"}
                          </>
                        )}
                      </div>
                    </div>
                    <Badge variant="outline">{listing.category}</Badge>
                  </div>

                  <p className="text-muted-foreground text-sm mt-2 line-clamp-2">{listing.description}</p>

                  <div className="flex items-center mt-3 text-sm text-muted-foreground gap-2 flex-wrap">
                    <Link
                      href={listing.ownerPath || `/profile/${seller.username || seller.id}`}
                      className="flex items-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Avatar className="h-6 w-6 mr-2">
                        <AvatarImage src={seller.avatar || "/placeholder.svg"} alt={seller.name} />
                        <AvatarFallback className="text-xs">{seller.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <span>{seller.name}</span>
                    </Link>
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                      {listing.ownerLabel || "Member offer"}
                    </Badge>
                    <span>•</span>
                    <span>{listing.location}</span>
                  </div>
                </CardContent>

                <CardFooter className="p-4 pt-0 flex justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      // Prevent parent card navigation when handling a card action.
                      e.stopPropagation()
                      onContact(listing.id)
                    }}
                  >
                    <MessageCircle className="h-4 w-4 mr-2" />
                    Contact
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        // Save is delegated to parent logic; this component only forwards the listing ID.
                        e.stopPropagation()
                        onSave(listing.id)
                      }}
                      className={isSaved ? "text-primary" : ""}
                      aria-label={isSaved ? "Unsave listing" : "Save listing"}
                    >
                      <Bookmark className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        // Share action is handled by the parent callback.
                        e.stopPropagation()
                        onShare(listing.id)
                      }}
                      aria-label="Share listing"
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
