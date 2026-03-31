import type { Metadata } from "next"
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers"
import { absoluteUrl } from "@/lib/structured-data"

function clean(value?: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length > 0 ? normalized : undefined
}

function absoluteImage(image?: string | null): string | undefined {
  if (!image) return undefined
  return absoluteUrl(image)
}

type MetadataInput = {
  title: string
  description?: string | null
  path: string
  image?: string | null
  type?: "website" | "article" | "profile"
}

export function buildObjectMetadata(input: MetadataInput): Metadata {
  const description = clean(input.description) || "Community page on RIVR"
  const url = absoluteUrl(input.path)
  const image = absoluteImage(input.image)

  return {
    title: `${input.title} | RIVR`,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: input.title,
      description,
      url,
      type: input.type || "website",
      images: image ? [{ url: image }] : undefined,
      siteName: "RIVR",
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: input.title,
      description,
      images: image ? [image] : undefined,
    },
  }
}

export function buildPersonMetadata(agent: SerializedAgent, username: string): Metadata {
  return buildObjectMetadata({
    title: agent.name || username,
    description:
      agent.description ||
      (typeof agent.metadata?.bio === "string" ? agent.metadata.bio : null) ||
      `Profile for @${username} on RIVR`,
    path: `/profile/${username}`,
    image: agent.image,
    type: "profile",
  })
}

export function buildGroupPageMetadata(agent: SerializedAgent, path: string): Metadata {
  return buildObjectMetadata({
    title: agent.name,
    description: agent.description,
    path,
    image: agent.image,
    type: "website",
  })
}

export function buildResourcePageMetadata(resource: SerializedResource, path: string): Metadata {
  return buildObjectMetadata({
    title: resource.name,
    description: resource.description || resource.content || undefined,
    path,
    image:
      Array.isArray(resource.metadata?.images) && typeof resource.metadata.images[0] === "string"
        ? resource.metadata.images[0]
        : null,
    type: "article",
  })
}
