import { notFound } from "next/navigation"
import { fetchMarketplaceListingById, fetchPostDetail } from "@/app/actions/graph"
import { PostDetailClient } from "@/components/post-detail-client"
import { resourceToMarketplaceListing, resourceToPost } from "@/lib/graph-adapters"
import type { Metadata } from "next"
import { buildPostStructuredData, serializeJsonLd } from "@/lib/structured-data"
import type { MarketplaceListing, Post } from "@/lib/types"
import type { SerializedResource } from "@/lib/graph-serializers"

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
    notFound()
  }

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
