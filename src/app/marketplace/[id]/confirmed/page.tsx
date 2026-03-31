import Image from "next/image"
import Link from "next/link"
import { notFound } from "next/navigation"
import { CheckCircle, ArrowRight, MessageCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { fetchMarketplaceListingById } from "@/app/actions/graph"
import { resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { formatMarketplaceListingTypeLabel } from "@/lib/listing-types"

export default async function MarketplaceItemConfirmedPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params
  const detail = await fetchMarketplaceListingById(resolvedParams.id)

  if (!detail?.owner) {
    notFound()
  }

  const listing = resourceToMarketplaceListing(detail.resource, detail.owner)
  const seller = listing.seller
  const orderNumber = `ORD-${resolvedParams.id.slice(0, 8).toUpperCase()}`
  const ownerHref = listing.ownerPath || `/profile/${seller.username || seller.id}`
  const ownerActionLabel = listing.ownerKind === "group" ? `Contact ${seller.name}` : `Contact ${seller.name}`

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 text-center">
      <div className="mb-8 flex justify-center">
        <div className="rounded-full bg-green-100 p-3">
          <CheckCircle className="h-12 w-12 text-green-600" />
        </div>
      </div>

      <h1 className="text-3xl font-bold mb-2">Purchase Successful!</h1>
      <p className="text-muted-foreground mb-8">
        {listing.type === "product"
          ? "Your order has been confirmed and is being processed."
          : `Your ${formatMarketplaceListingTypeLabel(listing.type).toLowerCase()} purchase has been confirmed.`}
      </p>

      <div className="bg-muted p-6 rounded-lg mb-8">
        <div className="flex items-center justify-center mb-4">
          <div className="relative w-20 h-20 rounded-md overflow-hidden mr-4">
            <Image
              src={getPrimaryListingImage(listing)}
              alt={listing.title}
              fill
              className="object-cover"
            />
          </div>
          <div className="text-left">
            <h2 className="font-semibold text-lg">{listing.title}</h2>
            <p className="text-muted-foreground">{listing.price}</p>
          </div>
        </div>

        <div className="border-t pt-4 text-left">
          <div className="flex justify-between mb-2">
            <span className="text-muted-foreground">Order Number:</span>
            <span className="font-medium">{orderNumber}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Date:</span>
            <span className="font-medium">{new Date().toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <Button asChild variant="outline" className="w-full">
          <Link href={`/messages?user=${seller.id}`}>
            <MessageCircle className="h-4 w-4 mr-2" />
            {ownerActionLabel}
          </Link>
        </Button>

        <Button asChild variant="outline" className="w-full">
          <Link href={ownerHref}>
            View {listing.ownerKind === "group" ? "Owner" : "Seller"}
          </Link>
        </Button>

        <Button asChild variant="outline" className="w-full">
          <Link href="/profile?tab=wallet&walletTab=purchases">View My Purchases</Link>
        </Button>

        <Button asChild className="w-full">
          <Link href="/">
            Back to Mart
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  )
}
