import { PageNotFoundView } from "@/components/page-not-found-view"
import type { Metadata } from "next"
import { fetchMarketplaceListingById } from "@/app/actions/graph"
import { MarketplaceItemPageClient } from "@/components/marketplace-item-page-client"
import { resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { buildObjectMetadata } from "@/lib/object-metadata"
import { buildOfferStructuredData, serializeJsonLd } from "@/lib/structured-data"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { redirectIfSovereignResource } from "@/lib/federation/sovereign-resource-redirect"

async function getMarketplacePageData(id: string) {
  const detail = await fetchMarketplaceListingById(id)
  if (!detail) return null
  const listing = resourceToMarketplaceListing(detail.resource, detail.owner ?? undefined)
  return { detail, listing }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const data = await getMarketplacePageData(id)

  if (!data) {
    return {
      title: "Listing Not Found | RIVR",
    }
  }

  return buildObjectMetadata({
    title: data.listing.title,
    description: data.listing.description,
    path: `/marketplace/${data.listing.id}`,
    image: getPrimaryListingImage(data.listing, "") || null,
    type: "article",
  })
}

export default async function MarketplaceItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getMarketplacePageData(id)

  if (!data) {
    // Render the not-found view rather than calling notFound(): generateMetadata
    // already awaited this same data, so a late notFound() re-renders the
    // AppRouter mid-hydration and crashes anonymous visitors with React #310
    // (audit S-3).
    return <PageNotFoundView title="Listing not found" message="This marketplace listing doesn't exist, or it has been removed." />
  }

  // Universal Manifest v0.4: if this listing is a federated mirror of a
  // sovereign-homed resource, bounce to the canonical origin so the
  // authoritative price, inventory, fee config, and settlement run there.
  await redirectIfSovereignResource(id, {
    metadata: (data.detail.resource.metadata ?? null) as Record<string, unknown> | null,
  })

  const structuredData = buildOfferStructuredData(data.listing, {
    visibility: data.detail.resource.visibility ?? (data.detail.resource.isPublic ? "public" : "private"),
  })

  return (
    <>
      {structuredData.map((entry, index) => (
        <script
          key={`${data.listing.id}-jsonld-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(entry) }}
        />
      ))}
      <MarketplaceItemPageClient
        params={Promise.resolve({ id })}
        initialResource={data.detail.resource}
        initialOwner={data.detail.owner ?? undefined}
      />
    </>
  )
}
