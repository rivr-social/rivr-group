import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { db } from "@/db"
import { agents, resources } from "@/db/schema"
import { agentToGroup, agentToUser, resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { serializeAgent, serializeResource } from "@/lib/graph-serializers"
import { absoluteUrl, isSearchVisibleVisibility } from "@/lib/structured-data"
import { canPublishEntity, inferGroupPublicationKind } from "@/lib/publication-policy"

type MurmurationsKind = "person" | "organization" | "project" | "offer"

const SCHEMA_BASE_URL =
  process.env.MURMURATIONS_SCHEMA_BASE_URL?.replace(/\/+$/, "") ||
  "https://test-cdn.murmurations.network/schemas"

const MURMURATIONS_SCHEMA_URLS = {
  person: process.env.MURMURATIONS_PEOPLE_SCHEMA_URL || `${SCHEMA_BASE_URL}/people_schema-v1.0.0.json`,
  organization:
    process.env.MURMURATIONS_ORGANIZATIONS_SCHEMA_URL || `${SCHEMA_BASE_URL}/organizations_schema-v1.0.0.json`,
  project: process.env.MURMURATIONS_PROJECTS_SCHEMA_URL || `${SCHEMA_BASE_URL}/projects_schema-v1.0.0.json`,
  offer: process.env.MURMURATIONS_OFFERS_WANTS_SCHEMA_URL || `${SCHEMA_BASE_URL}/offers_wants_schema-v1.0.0.json`,
} as const

function murmurationsEnabled(meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.murmurationsPublishing === true
}

function publicVisibility(visibility?: string | null): boolean {
  return isSearchVisibleVisibility(visibility ?? null)
}

function socialLinksFromMetadata(meta: Record<string, unknown>): string[] {
  const socialLinks = meta.socialLinks
  if (!socialLinks || typeof socialLinks !== "object" || Array.isArray(socialLinks)) return []
  return Object.values(socialLinks).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function localeTags(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.chapterTags) ? meta.chapterTags.filter((tag): tag is string => typeof tag === "string") : []
}

function routeForGroupType(meta: Record<string, unknown>, id: string): string {
  const groupType = `${meta.groupType ?? ""}`.toLowerCase()
  if (groupType === "ring") return `/rings/${id}`
  if (groupType === "family") return `/families/${id}`
  return `/groups/${id}`
}

export function getMurmurationsProfileUrl(kind: MurmurationsKind, id: string): string {
  return absoluteUrl(`/api/murmurations/profiles/${kind}/${id}`)
}

async function getOptedInActor(actorId: string) {
  const actor = await db.query.agents.findFirst({
    where: and(eq(agents.id, actorId), isNull(agents.deletedAt)),
  })
  if (!actor) return null
  const metadata = (actor.metadata ?? {}) as Record<string, unknown>
  if (!murmurationsEnabled(metadata)) return null
  return actor
}

async function getOrganizationsCreatedBy(actorId: string) {
  const result = await db.execute(sql`
    select id
    from agents
    where deleted_at is null
      and type = 'organization'
      and visibility in ('public', 'locale')
      and coalesce(metadata->>'creatorId', '') = ${actorId}
  `)
  return result
    .map((row: Record<string, unknown>) => row.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
}

function normalizeMurmurationsUrls(urls: string[]): string[] {
  return Array.from(new Set(urls.filter((url) => typeof url === "string" && url.length > 0)))
}

export async function listMurmurationsProfileUrlsForActor(actorId: string): Promise<string[]> {
  const actor = await getOptedInActor(actorId)
  if (!actor) return []

  const organizationIds = await getOrganizationsCreatedBy(actorId)
  const ownerIds = normalizeMurmurationsUrls([actorId, ...organizationIds])
  const urls: string[] = []

  if (publicVisibility(actor.visibility)) {
    urls.push(getMurmurationsProfileUrl("person", actor.id))
  }

  for (const organizationId of organizationIds) {
    urls.push(getMurmurationsProfileUrl("organization", organizationId))
  }

  const publishableResources = await db.query.resources.findMany({
    where: and(
      inArray(resources.ownerId, ownerIds),
      inArray(resources.visibility, ["public", "locale"]),
      isNull(resources.deletedAt)
    ),
  })

  for (const resource of publishableResources) {
    const metadata = (resource.metadata ?? {}) as Record<string, unknown>
    const listingType = typeof metadata.listingType === "string" || `${metadata.listingKind ?? ""}`.toLowerCase() === "marketplace-listing"
    const resourceKind = `${metadata.resourceKind ?? resource.type}`.toLowerCase()

    if (listingType) {
      urls.push(getMurmurationsProfileUrl("offer", resource.id))
      continue
    }

    if (resource.type === "project" || resourceKind === "project") {
      urls.push(getMurmurationsProfileUrl("project", resource.id))
    }
  }

  return normalizeMurmurationsUrls(urls)
}

async function postProfileUrlToIndex(profileUrl: string) {
  const endpoint = process.env.MURMURATIONS_INDEX_UPDATER_URL?.trim()
  if (!endpoint) {
    return { ok: false, skipped: true, profileUrl }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  if (process.env.MURMURATIONS_INDEX_UPDATER_TOKEN?.trim()) {
    headers.authorization = `Bearer ${process.env.MURMURATIONS_INDEX_UPDATER_TOKEN.trim()}`
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ profile_url: profileUrl }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(`Murmurations index updater rejected ${profileUrl}: ${response.status} ${errorText}`)
  }

  return { ok: true, skipped: false, profileUrl }
}

export async function syncMurmurationsProfilesForActor(actorId: string) {
  const urls = await listMurmurationsProfileUrlsForActor(actorId)
  const results = []
  for (const url of urls) {
    results.push(await postProfileUrlToIndex(url))
  }
  return {
    profileUrls: urls,
    results,
  }
}

export async function syncAllMurmurationsProfiles() {
  const optedInActors = await db.execute(sql`
    select id
    from agents
    where deleted_at is null
      and type = 'person'
      and coalesce((metadata->>'murmurationsPublishing')::boolean, false) = true
  `)

  const actorIds = optedInActors
    .map((row: Record<string, unknown>) => row.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0)

  const results = []
  for (const actorId of actorIds) {
    results.push({
      actorId,
      ...(await syncMurmurationsProfilesForActor(actorId)),
    })
  }

  return {
    actorCount: actorIds.length,
    results,
  }
}

async function loadOwnerPublishingState(ownerId: string): Promise<boolean> {
  const directOwner = await db.query.agents.findFirst({
    where: and(eq(agents.id, ownerId), isNull(agents.deletedAt)),
  })

  if (!directOwner) return false
  const directMeta = (directOwner.metadata ?? {}) as Record<string, unknown>

  if (directOwner.type === "person") {
    return murmurationsEnabled(directMeta)
  }

  const creatorId = typeof directMeta.creatorId === "string" ? directMeta.creatorId : null
  if (!creatorId) return false
  return !!(await getOptedInActor(creatorId))
}

export async function buildPersonMurmurationsProfile(id: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
  })
  if (!agent || agent.type !== "person" || !publicVisibility(agent.visibility)) return null

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  if (!murmurationsEnabled(metadata)) return null

  const user = agentToUser(serializeAgent(agent))
  const primaryUrl = absoluteUrl(`/profile/${user.username || user.id}`)

  return {
    linked_schemas: [MURMURATIONS_SCHEMA_URLS.person],
    profile_url: getMurmurationsProfileUrl("person", id),
    primary_url: primaryUrl,
    name: user.name,
    description: user.bio || undefined,
    image: user.avatar || undefined,
    tags: normalizeMurmurationsUrls([...(user.skills ?? []), ...(user.chapterTags ?? [])]),
    urls: normalizeMurmurationsUrls([primaryUrl, ...socialLinksFromMetadata(metadata)]),
    locality: user.homeLocale || undefined,
    last_updated: agent.updatedAt.toISOString(),
  }
}

export async function buildOrganizationMurmurationsProfile(id: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
  })
  if (!agent || agent.type !== "organization") return null

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  const groupKind = inferGroupPublicationKind(metadata)
  if (!canPublishEntity("murmurations", groupKind, agent.visibility)) return null
  const creatorId = typeof metadata.creatorId === "string" ? metadata.creatorId : null
  if (!creatorId || !(await getOptedInActor(creatorId))) return null

  const group = agentToGroup(serializeAgent(agent))
  const primaryUrl = absoluteUrl(routeForGroupType(metadata, group.id))

  return {
    linked_schemas: [MURMURATIONS_SCHEMA_URLS.organization],
    profile_url: getMurmurationsProfileUrl("organization", id),
    primary_url: primaryUrl,
    name: group.name,
    description: group.description || undefined,
    image: group.image || undefined,
    tags: normalizeMurmurationsUrls([...(group.tags ?? []), ...(group.chapterTags ?? [])]),
    urls: normalizeMurmurationsUrls([primaryUrl, ...(group.website ? [group.website] : [])]),
    locality: localeTags(metadata)[0] || undefined,
    last_updated: agent.updatedAt.toISOString(),
  }
}

export async function buildProjectMurmurationsProfile(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource || !canPublishEntity("murmurations", "project", resource.visibility)) return null

  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const isProject = resource.type === "project" || `${metadata.resourceKind ?? ""}`.toLowerCase() === "project"
  if (!isProject || !(await loadOwnerPublishingState(resource.ownerId))) return null

  const primaryUrl = absoluteUrl(`/projects/${resource.id}`)

  return {
    linked_schemas: [MURMURATIONS_SCHEMA_URLS.project],
    profile_url: getMurmurationsProfileUrl("project", id),
    primary_url: primaryUrl,
    name: resource.name,
    description: resource.description || undefined,
    tags: normalizeMurmurationsUrls([...(resource.tags ?? []), ...localeTags(metadata)]),
    urls: [primaryUrl],
    locality: localeTags(metadata)[0] || undefined,
    last_updated: resource.updatedAt.toISOString(),
  }
}

export async function buildOfferMurmurationsProfile(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource || !canPublishEntity("murmurations", "offer", resource.visibility)) return null

  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const listingType = typeof metadata.listingType === "string" || `${metadata.listingKind ?? ""}`.toLowerCase() === "marketplace-listing"
  if (!listingType || !(await loadOwnerPublishingState(resource.ownerId))) return null

  const listing = resourceToMarketplaceListing(serializeResource(resource))
  const primaryUrl = absoluteUrl(`/marketplace/${resource.id}`)

  return {
    linked_schemas: [MURMURATIONS_SCHEMA_URLS.offer],
    profile_url: getMurmurationsProfileUrl("offer", id),
    primary_url: primaryUrl,
    name: listing.title,
    description: listing.description || undefined,
    tags: normalizeMurmurationsUrls([...(listing.tags ?? []), ...localeTags(metadata)]),
    urls: [primaryUrl],
    offer_want_type: "offer",
    category: listing.category || undefined,
    price: listing.price || undefined,
    locality: localeTags(metadata)[0] || undefined,
    last_updated: resource.updatedAt.toISOString(),
  }
}
