import type { Group, Post } from "@/lib/types"
import { canPublishEntity, inferGroupPublicationKind } from "@/lib/publication-policy"

type EventLike = {
  id: string
  name: string
  description?: string
  image?: string
  price?: string
  chapterTags?: string[]
  timeframe?: {
    start?: string
    end?: string
  }
  location?: {
    name?: string
    address?: string
  } | string
}

type ProfileLike = {
  id: string
  name: string
  description?: string | null
  image?: string | null
  username?: string | null
  location?: string | null
  chapterTags?: string[]
  skills?: string[]
  metadata?: Record<string, unknown> | null
}

type ProjectLike = {
  id: string
  name: string
  description?: string | null
  image?: string | null
  location?: string | null
  chapterTags?: string[]
  tags?: string[]
  status?: string | null
}

type ListingLike = {
  id: string
  title: string
  description?: string | null
  price?: string | null
  currency?: string | null
  type?: string | null
  category?: string | null
  location?: string | null
  images?: string[]
  seller?: {
    id: string
    name: string
    username?: string | null
  } | null
}

const DEFAULT_SITE_ORIGIN = "https://app.rivr.social"

function getSiteOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    DEFAULT_SITE_ORIGIN
  ).replace(/\/+$/, "")
}

export function isSearchVisibleVisibility(visibility?: string | null): boolean {
  return canPublishEntity("search", "post", visibility)
}

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${getSiteOrigin()}${normalizedPath}`
}

function cleanText(value?: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length > 0 ? normalized : undefined
}

function cleanTextArray(values?: Array<string | null | undefined>): string[] | undefined {
  if (!Array.isArray(values)) return undefined
  const cleaned = values
    .map((value) => cleanText(value))
    .filter((value): value is string => typeof value === "string")
  return cleaned.length > 0 ? cleaned : undefined
}

function extractImage(image?: string | null): string[] | undefined {
  if (!image) return undefined
  return [absoluteUrl(image)]
}

function extractSameAs(metadata?: Record<string, unknown> | null): string[] | undefined {
  if (!metadata) return undefined
  const urls = new Set<string>()
  const website = metadata.website
  if (typeof website === "string" && website.trim().length > 0) {
    urls.add(website.trim())
  }
  const socialLinks = metadata.socialLinks ?? metadata.social_links
  if (socialLinks && typeof socialLinks === "object" && !Array.isArray(socialLinks)) {
    for (const value of Object.values(socialLinks)) {
      if (typeof value === "string" && value.trim().length > 0) {
        urls.add(value.trim())
      }
    }
  }
  return urls.size > 0 ? Array.from(urls) : undefined
}

function buildAreaServed(chapterTags?: string[]): Array<{ "@type": "DefinedRegion"; identifier: string }> | undefined {
  if (!Array.isArray(chapterTags) || chapterTags.length === 0) return undefined
  return chapterTags
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .map((tag) => ({
      "@type": "DefinedRegion" as const,
      identifier: tag,
    }))
}

function offerItemType(post: Post): "Product" | "Service" {
  const offeringType = `${post.offeringType ?? ""}`.toLowerCase()
  return offeringType === "service" || offeringType === "skill" ? "Service" : "Product"
}

export function buildPostStructuredData(post: Post, options: { visibility?: string | null }) {
  if (!canPublishEntity("search", "post", options.visibility)) return []

  const postUrl = absoluteUrl(`/posts/${post.id}`)
  const description = cleanText(post.content) || cleanText(post.description) || cleanText(post.title)
  const image = Array.isArray(post.images) && post.images.length > 0 ? extractImage(post.images[0]) : undefined
  const posting = {
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    "@id": `${postUrl}#post`,
    url: postUrl,
    headline: cleanText(post.title) || (description ? description.slice(0, 110) : `Post by ${post.author.name}`),
    articleBody: description,
    datePublished: post.createdAt,
    author: {
      "@type": "Person",
      name: post.author.name,
      url: absoluteUrl(`/profile/${post.author.username || post.author.id}`),
    },
    image,
    audience: buildAreaServed(post.chapterTags),
    keywords: post.tags?.join(", ") || undefined,
  }

  const unitPriceCents =
    typeof post.dealPriceCents === "number"
      ? post.dealPriceCents
      : typeof post.basePrice === "number"
        ? Math.round(post.basePrice * 100)
        : undefined

  if (!post.linkedOfferingId && unitPriceCents === undefined && post.postType !== "offer") {
    return [posting]
  }

  const offerUrl = post.linkedOfferingId
    ? absoluteUrl(`/marketplace/${post.linkedOfferingId}${post.dealPriceCents ? `?dealPostId=${post.id}` : ""}`)
    : postUrl

  const itemType = offerItemType(post)
  const offer = {
    "@context": "https://schema.org",
    "@type": "Offer",
    "@id": `${postUrl}#offer`,
    url: offerUrl,
    priceCurrency: post.currency || "USD",
    price: unitPriceCents !== undefined ? (unitPriceCents / 100).toFixed(2) : undefined,
    availability: "https://schema.org/InStock",
    validFrom: post.createdAt,
    validThrough:
      typeof post.dealDurationHours === "number"
        ? new Date(new Date(post.createdAt).getTime() + post.dealDurationHours * 60 * 60 * 1000).toISOString()
        : undefined,
    seller: {
      "@type": "Person",
      name: post.author.name,
      url: absoluteUrl(`/profile/${post.author.username || post.author.id}`),
    },
    eligibleRegion: buildAreaServed(post.chapterTags),
    priceSpecification: typeof post.dealPriceCents === "number" && typeof post.basePrice === "number"
      ? {
          "@type": "UnitPriceSpecification",
          priceCurrency: post.currency || "USD",
          price: (post.dealPriceCents / 100).toFixed(2),
          referenceQuantity: {
            "@type": "QuantitativeValue",
            value: 1,
          },
        }
      : undefined,
    itemOffered: {
      "@type": itemType,
      name: cleanText(post.title) || cleanText(post.description) || "Community offer",
      description,
      image,
      category: cleanText(post.offeringType),
      sku: post.linkedOfferingId || post.id,
    },
  }

  return [posting, offer]
}

export function buildEventStructuredData(
  event: EventLike,
  options: { visibility?: string | null; organizerName?: string }
) {
  if (!canPublishEntity("search", "event", options.visibility)) return null

  const eventUrl = absoluteUrl(`/events/${event.id}`)
  const image = extractImage(event.image)
  const locationName = typeof event.location === "string"
    ? event.location
    : event.location?.name || event.location?.address
  const locationAddress = typeof event.location === "string" ? event.location : event.location?.address
  const numericPrice = Number(event.price ?? 0)

  return {
    "@context": "https://schema.org",
    "@type": "Event",
    "@id": `${eventUrl}#event`,
    url: eventUrl,
    name: cleanText(event.name) || "Event",
    description: cleanText(event.description),
    image,
    startDate: event.timeframe?.start,
    endDate: event.timeframe?.end || event.timeframe?.start,
    eventAttendanceMode: locationName ? "https://schema.org/OfflineEventAttendanceMode" : "https://schema.org/OnlineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: locationName
      ? {
          "@type": "Place",
          name: locationName,
          address: locationAddress,
        }
      : undefined,
    organizer: options.organizerName
      ? {
          "@type": "Organization",
          name: options.organizerName,
        }
      : undefined,
    offers: Number.isFinite(numericPrice) && numericPrice > 0
      ? {
          "@type": "Offer",
          url: eventUrl,
          priceCurrency: "USD",
          price: numericPrice.toFixed(2),
          availability: "https://schema.org/InStock",
        }
      : undefined,
    audience: buildAreaServed(event.chapterTags),
  }
}

export function buildGroupStructuredData(
  group: Group,
  options: { path: string; visibility?: string | null; groupType?: string | null; memberCount?: number }
) {
  const entityKind = inferGroupPublicationKind({ groupType: options.groupType })
  if (!canPublishEntity("search", entityKind, options.visibility)) return null

  const url = absoluteUrl(options.path)
  const image = extractImage(group.image || group.avatar)

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${url}#organization`,
    url,
    name: cleanText(group.name) || "Rivr Organization",
    description: cleanText(group.description),
    image,
    logo: image?.[0],
    memberOf: {
      "@type": "Organization",
      name: "Rivr",
      url: getSiteOrigin(),
    },
    address: cleanText(group.location),
    areaServed: buildAreaServed(group.chapterTags),
    interactionStatistic:
      typeof options.memberCount === "number"
        ? {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/JoinAction",
            userInteractionCount: options.memberCount,
          }
        : undefined,
    additionalType: options.groupType || undefined,
    sameAs: group.website ? [group.website] : undefined,
  }
}

export function buildProfileStructuredData(
  profile: ProfileLike,
  options: { visibility?: string | null }
) {
  if (!canPublishEntity("search", "person", options.visibility)) return null

  const profileUrl = absoluteUrl(`/profile/${profile.username || profile.id}`)
  const image = extractImage(profile.image)

  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${profileUrl}#person`,
    url: profileUrl,
    name: cleanText(profile.name) || "Rivr Profile",
    description: cleanText(profile.description),
    image,
    identifier: cleanText(profile.username) || profile.id,
    address: cleanText(profile.location),
    areaServed: buildAreaServed(profile.chapterTags),
    knowsAbout: cleanTextArray(profile.skills),
    sameAs: extractSameAs(profile.metadata),
  }
}

export function buildProjectStructuredData(
  project: ProjectLike,
  options: { visibility?: string | null; ownerName?: string | null }
) {
  if (!canPublishEntity("search", "project", options.visibility)) return null

  const projectUrl = absoluteUrl(`/projects/${project.id}`)
  const image = extractImage(project.image)

  return {
    "@context": "https://schema.org",
    "@type": "Project",
    "@id": `${projectUrl}#project`,
    url: projectUrl,
    name: cleanText(project.name) || "Rivr Project",
    description: cleanText(project.description),
    image,
    keywords: cleanTextArray(project.tags)?.join(", "),
    location: cleanText(project.location)
      ? {
          "@type": "Place",
          name: cleanText(project.location),
        }
      : undefined,
    areaServed: buildAreaServed(project.chapterTags),
    creator: options.ownerName
      ? {
          "@type": "Person",
          name: options.ownerName,
        }
      : undefined,
    additionalType: cleanText(project.status),
  }
}

export function buildOfferStructuredData(
  listing: ListingLike,
  options: { visibility?: string | null }
) {
  if (!canPublishEntity("search", "offer", options.visibility)) return []

  const listingUrl = absoluteUrl(`/marketplace/${listing.id}`)
  const image = extractImage(listing.images?.[0])
  const itemType = `${listing.type ?? ""}`.toLowerCase() === "service" ? "Service" : "Product"
  const sellerPath = listing.seller ? `/profile/${listing.seller.username || listing.seller.id}` : undefined

  return [
    {
      "@context": "https://schema.org",
      "@type": itemType,
      "@id": `${listingUrl}#item`,
      url: listingUrl,
      name: cleanText(listing.title) || "Marketplace listing",
      description: cleanText(listing.description),
      image,
      category: cleanText(listing.category) || cleanText(listing.type),
      brand: listing.seller
        ? {
            "@type": "Person",
            name: cleanText(listing.seller.name),
            url: sellerPath ? absoluteUrl(sellerPath) : undefined,
          }
        : undefined,
      offers: {
        "@type": "Offer",
        "@id": `${listingUrl}#offer`,
        url: listingUrl,
        priceCurrency: cleanText(listing.currency) || "USD",
        price: cleanText(listing.price)?.replace(/[^0-9.]/g, "") || undefined,
        availability: "https://schema.org/InStock",
        areaServed: cleanText(listing.location)
          ? {
              "@type": "Place",
              name: cleanText(listing.location),
            }
          : undefined,
        seller: listing.seller
          ? {
              "@type": "Person",
              name: cleanText(listing.seller.name),
              url: sellerPath ? absoluteUrl(sellerPath) : undefined,
            }
          : undefined,
      },
    },
  ]
}

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}
