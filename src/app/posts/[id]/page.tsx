import { PageNotFoundView } from "@/components/page-not-found-view"
import { fetchMarketplaceListingById, fetchPostDetail } from "@/app/actions/graph"
import { PostDetailClient } from "@/components/post-detail-client"
import { resourceToMarketplaceListing, resourceToPost } from "@/lib/graph-adapters"
import type { Metadata } from "next"
import { buildPostStructuredData, serializeJsonLd } from "@/lib/structured-data"
import type { MarketplaceListing, Post } from "@/lib/types"
import type { SerializedResource } from "@/lib/graph-serializers"
import { redirectIfSovereignResource } from "@/lib/federation/sovereign-resource-redirect"

async function getPostPageData(id: string) {
  const detail = await fetchPostDetail(id)
  if (!detail) return null
  const post = resourceToPost(detail.resource, detail.author ?? undefined) as Post
  const linkedOffering = post.linkedOfferingId
    ? await fetchMarketplaceListingById(post.linkedOfferingId)
    : null

  return {
    detail,
    post,
    linkedOffering: linkedOffering
      ? {
          resource: linkedOffering.resource as SerializedResource,
          listing: resourceToMarketplaceListing(
            linkedOffering.resource as SerializedResource,
            linkedOffering.owner ?? undefined
          ) as MarketplaceListing,
        }
      : null,
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const data = await getPostPageData(id)

  if (!data) {
    return {
      title: "Post Not Found | RIVR",
    }
  }

  return {
    title: `${data.post.title || data.post.author.name} | RIVR`,
    description: data.post.content || data.post.title || "Community post on RIVR",
  }
}

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getPostPageData(id)

  if (!data) {
    // Render the not-found view rather than calling notFound(): generateMetadata
    // already awaited this same data, so a late notFound() re-renders the
    // AppRouter mid-hydration and crashes anonymous visitors with React #310
    // (audit S-3).
    return <PageNotFoundView title="Post not found" message="This post doesn't exist, or it has been deleted." />
  }

  // Universal Manifest v0.4: bounce federated mirrors of sovereign-homed
  // resources to their canonical origin so the authoritative copy renders.
  await redirectIfSovereignResource(id, {
    metadata: (data.detail.resource.metadata ?? null) as Record<string, unknown> | null,
  })

  const structuredData = buildPostStructuredData(data.post, {
    visibility: data.detail.resource.visibility ?? (data.detail.resource.isPublic ? "public" : "private"),
  })

  return (
    <>
      {structuredData.map((entry, index) => (
        <script
          key={`${data.post.id}-jsonld-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(entry) }}
        />
      ))}
      <PostDetailClient
        post={data.post}
        resource={data.detail.resource}
        linkedOffering={data.linkedOffering?.listing}
      />
    </>
  )
}
