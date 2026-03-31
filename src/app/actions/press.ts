"use server"

import { auth } from "@/auth"
import { db } from "@/db"
import { agents } from "@/db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { isGroupAdmin } from "@/app/actions/group-admin"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type GroupPressSources = {
  substackUrl?: string
  youtubeUrl?: string
  instagramHandle?: string
}

export type PressFeedItem = {
  id: string
  title: string
  excerpt?: string
  url: string
  publishedAt?: string
  source: "substack" | "youtube" | "instagram"
  author?: string
  imageUrl?: string
}

export type PressFeedResult = {
  sources: GroupPressSources
  articles: PressFeedItem[]
  media: PressFeedItem[]
  sourceErrors: Partial<Record<PressFeedItem["source"], string>>
}

function getMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function normalizeUrl(input?: string | null): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function normalizeInstagramHandle(input?: string | null): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  if (trimmed.includes("instagram.com/")) {
    const match = trimmed.match(/instagram\.com\/([^/?#]+)/i)
    return match?.[1]?.replace(/^@/, "")
  }
  return trimmed.replace(/^@/, "")
}

function decodeXml(value?: string): string {
  if (!value) return ""
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractXmlValue(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match?.[1]
}

function extractAtomLink(block: string): string | undefined {
  const alternate = block.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i)
  if (alternate?.[1]) return alternate[1]
  const anyHref = block.match(/<link[^>]+href=["']([^"']+)["']/i)
  return anyHref?.[1]
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; RivrPressBot/1.0)" },
      next: { revalidate: 1800 },
    })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

function normalizeSubstackFeedUrl(input?: string): string | null {
  const normalized = normalizeUrl(input)
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    if (!url.pathname.endsWith("/feed")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/feed`
    }
    return url.toString()
  } catch {
    return null
  }
}

function normalizeYoutubeProfileUrl(input?: string): string | null {
  const normalized = normalizeUrl(input)
  return normalized ?? null
}

async function resolveYoutubeFeedUrl(input?: string): Promise<string | null> {
  const normalized = normalizeYoutubeProfileUrl(input)
  if (!normalized) return null

  try {
    const direct = new URL(normalized)
    const channelMatch = direct.pathname.match(/\/channel\/(UC[\w-]+)/i)
    if (channelMatch?.[1]) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`
    }
  } catch {
    return null
  }

  const html = await fetchText(normalized)
  if (!html) return null
  const channelMatch =
    html.match(/"channelId":"(UC[\w-]+)"/) ??
    html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)/)
  if (!channelMatch?.[1]) return null
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`
}

async function fetchSubstackItems(input?: string): Promise<{ items: PressFeedItem[]; error?: string }> {
  const feedUrl = normalizeSubstackFeedUrl(input)
  if (!feedUrl) return { items: [] }
  const xml = await fetchText(feedUrl)
  if (!xml) return { items: [], error: "Could not load the Substack feed." }

  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .slice(0, 8)
    .map((match, index) => {
      const block = match[0]
      const title = decodeXml(extractXmlValue(block, "title"))
      const excerpt = decodeXml(extractXmlValue(block, "description"))
      const url = decodeXml(extractXmlValue(block, "link"))
      const publishedAt = decodeXml(extractXmlValue(block, "pubDate"))
      if (!title || !url) return null
      return {
        id: `substack-${index}-${url}`,
        title,
        ...(excerpt ? { excerpt } : {}),
        url,
        ...(publishedAt ? { publishedAt } : {}),
        source: "substack" as const,
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  return { items }
}

async function fetchYoutubeItems(input?: string): Promise<{ items: PressFeedItem[]; error?: string }> {
  const feedUrl = await resolveYoutubeFeedUrl(input)
  if (!feedUrl) return { items: [] }
  const xml = await fetchText(feedUrl)
  if (!xml) return { items: [], error: "Could not load the YouTube feed." }

  const items = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)]
    .slice(0, 8)
    .map((match, index) => {
      const block = match[0]
      const title = decodeXml(extractXmlValue(block, "title"))
      const excerpt = decodeXml(extractXmlValue(block, "media:description"))
      const url = extractAtomLink(block) ?? ""
      const publishedAt = decodeXml(extractXmlValue(block, "published"))
      const author = decodeXml(extractXmlValue(block, "name"))
      const imageUrl = block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1]
      if (!title || !url) return null
      return {
        id: `youtube-${index}-${url}`,
        title,
        ...(excerpt ? { excerpt } : {}),
        url,
        ...(publishedAt ? { publishedAt } : {}),
        source: "youtube" as const,
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  return { items }
}

async function fetchInstagramProfile(handle?: string): Promise<{ items: PressFeedItem[]; error?: string }> {
  const normalizedHandle = normalizeInstagramHandle(handle)
  if (!normalizedHandle) return { items: [] }
  const profileUrl = `https://www.instagram.com/${normalizedHandle}/`
  const html = await fetchText(profileUrl)
  if (!html) {
    return {
      items: [{
        id: `instagram-${normalizedHandle}`,
        title: `Instagram @${normalizedHandle}`,
        url: profileUrl,
        source: "instagram",
      }],
      error: "Could not fetch Instagram profile details, showing the profile link instead.",
    }
  }

  const title =
    html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] ??
    `Instagram @${normalizedHandle}`
  const excerpt = html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1]
  const imageUrl = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1]

  return {
    items: [{
      id: `instagram-${normalizedHandle}`,
      title: decodeXml(title),
      excerpt: decodeXml(excerpt),
      url: profileUrl,
      source: "instagram",
      imageUrl,
    }],
  }
}

function dedupePressItems(items: PressFeedItem[]): PressFeedItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source}:${item.url.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function getGroupMetadata(groupId: string): Promise<Record<string, unknown> | null> {
  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1)

  if (!group) return null
  return getMetadataRecord(group.metadata)
}

export async function fetchGroupPressSourcesAction(groupId: string): Promise<GroupPressSources> {
  const session = await auth()
  if (!session?.user?.id) return {}
  if (!UUID_RE.test(groupId)) return {}
  const metadata = await getGroupMetadata(groupId)
  if (!metadata) return {}

  const pressSources = getMetadataRecord(metadata.pressSources)
  const socialLinks = getMetadataRecord(metadata.socialLinks)

  return {
    substackUrl:
      typeof pressSources.substackUrl === "string"
        ? pressSources.substackUrl
        : typeof socialLinks.substack === "string"
          ? socialLinks.substack
          : undefined,
    youtubeUrl:
      typeof pressSources.youtubeUrl === "string"
        ? pressSources.youtubeUrl
        : typeof socialLinks.youtube === "string"
          ? socialLinks.youtube
          : undefined,
    instagramHandle:
      typeof pressSources.instagramHandle === "string"
        ? pressSources.instagramHandle
        : typeof socialLinks.instagram === "string"
          ? socialLinks.instagram
          : undefined,
  }
}

export async function updateGroupPressSourcesAction(
  groupId: string,
  sources: GroupPressSources,
): Promise<{ success: boolean; error?: string }> {
  const session = await auth()
  if (!session?.user?.id) return { success: false, error: "Authentication required." }
  if (!UUID_RE.test(groupId)) return { success: false, error: "Invalid group." }

  const admin = await isGroupAdmin(session.user.id, groupId)
  if (!admin) return { success: false, error: "Only group admins can edit press sources." }

  const metadata = await getGroupMetadata(groupId)
  if (!metadata) return { success: false, error: "Group not found." }

  const socialLinks = getMetadataRecord(metadata.socialLinks)
  const nextPressSources: GroupPressSources = {
    substackUrl: normalizeUrl(sources.substackUrl),
    youtubeUrl: normalizeYoutubeProfileUrl(sources.youtubeUrl) ?? undefined,
    instagramHandle: normalizeInstagramHandle(sources.instagramHandle),
  }

  const nextSocialLinks = {
    ...socialLinks,
    ...(nextPressSources.substackUrl ? { substack: nextPressSources.substackUrl } : {}),
    ...(nextPressSources.youtubeUrl ? { youtube: nextPressSources.youtubeUrl } : {}),
    ...(nextPressSources.instagramHandle ? { instagram: nextPressSources.instagramHandle } : {}),
  }

  await db
    .update(agents)
    .set({
      metadata: {
        ...metadata,
        pressSources: nextPressSources,
        socialLinks: nextSocialLinks,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, groupId))

  revalidatePath(`/groups/${groupId}`)
  revalidatePath(`/rings/${groupId}`)
  revalidatePath(`/families/${groupId}`)

  return { success: true }
}

export async function fetchGroupPressFeedAction(groupId: string): Promise<PressFeedResult> {
  const session = await auth()
  if (!session?.user?.id) return { sources: {}, articles: [], media: [], sourceErrors: {} }
  const sources = await fetchGroupPressSourcesAction(groupId)
  const [substackResult, youtubeResult, instagramResult] = await Promise.all([
    fetchSubstackItems(sources.substackUrl),
    fetchYoutubeItems(sources.youtubeUrl),
    fetchInstagramProfile(sources.instagramHandle),
  ])

  return {
    sources,
    articles: dedupePressItems(substackResult.items),
    media: dedupePressItems([...youtubeResult.items, ...instagramResult.items]),
    sourceErrors: {
      ...(substackResult.error ? { substack: substackResult.error } : {}),
      ...(youtubeResult.error ? { youtube: youtubeResult.error } : {}),
      ...(instagramResult.error ? { instagram: instagramResult.error } : {}),
    },
  }
}
