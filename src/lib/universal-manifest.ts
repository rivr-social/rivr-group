import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/db"
import { agents, resources } from "@/db/schema"
import { agentToEvent, agentToGroup, agentToUser, resourceToMarketplaceListing, resourceToPost } from "@/lib/graph-adapters"
import { serializeAgent, serializeResource } from "@/lib/graph-serializers"
import { absoluteUrl } from "@/lib/structured-data"
import { canPublishEntity, inferGroupPublicationKind } from "@/lib/publication-policy"

type UniversalManifestKind = "person" | "organization" | "project" | "offer" | "event" | "post"

type ManifestPointer = {
  name: string
  value: string
}

type ManifestClaim = {
  name: string
  value: unknown
}

type ManifestConsent = {
  name: string
  value: boolean
}

type ManifestShard = {
  name: string
  value: Record<string, unknown>
}

const MANIFEST_CONTEXT = "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld"

function manifestOptIn(meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.murmurationsPublishing === true
}

function expiresAt(days = 30): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function linksFromMetadata(meta: Record<string, unknown>): string[] {
  const urls = new Set<string>()
  const website = meta.website
  if (typeof website === "string" && website.trim().length > 0) urls.add(website.trim())
  const socialLinks = meta.socialLinks
  if (socialLinks && typeof socialLinks === "object" && !Array.isArray(socialLinks)) {
    for (const value of Object.values(socialLinks)) {
      if (typeof value === "string" && value.trim().length > 0) urls.add(value.trim())
    }
  }
  return Array.from(urls)
}

function toManifestId(id: string): string {
  return `urn:uuid:${id}`
}

function dedupePointers(pointers: ManifestPointer[]): ManifestPointer[] {
  const seen = new Set<string>()
  return pointers.filter((pointer) => {
    const key = `${pointer.name}:${pointer.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildBaseManifest(
  id: string,
  canonicalUrl: string,
  manifestPath: string,
  pointers: ManifestPointer[],
  claims: ManifestClaim[],
  consents: ManifestConsent[],
  shards: ManifestShard[] = [],
) {
  return {
    "@context": MANIFEST_CONTEXT,
    "@id": toManifestId(id),
    "@type": "um:Manifest",
    manifestVersion: "0.1",
    subject: canonicalUrl,
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt(),
    pointers: dedupePointers([
      { name: "universalManifest.current", value: absoluteUrl(manifestPath) },
      ...pointers,
    ]),
    claims,
    consents,
    shards,
  }
}

function baseConsents(): ManifestConsent[] {
  return [
    { name: "publicDisplay", value: true },
    { name: "social.profilePublic", value: true },
  ]
}

function baseClaims(kind: UniversalManifestKind): ManifestClaim[] {
  return [
    { name: "role", value: kind },
    { name: "verification.status", value: "self-asserted" },
  ]
}

function pointersFromMetadata(meta: Record<string, unknown>, canonicalUrl: string, apiPath: string): ManifestPointer[] {
  const pointers: ManifestPointer[] = [
    { name: "consumerExperience", value: canonicalUrl },
    { name: "canonical", value: canonicalUrl },
    { name: "universalManifest.current", value: absoluteUrl(apiPath) },
  ]

  const matrixUserId = meta.matrixUserId
  if (typeof matrixUserId === "string" && matrixUserId.trim().length > 0) {
    pointers.push({ name: "matrix.userId", value: matrixUserId.trim() })
  }

  const activityPubActor = meta.activityPubActor
  if (typeof activityPubActor === "string" && activityPubActor.trim().length > 0) {
    pointers.push({ name: "activityPub.actor", value: activityPubActor.trim() })
  }

  for (const url of linksFromMetadata(meta)) {
    pointers.push({ name: "canonical", value: url })
  }

  return pointers
}

function identityPointersFromAgent(agent: typeof agents.$inferSelect): ManifestPointer[] {
  const pointers: ManifestPointer[] = []

  if (typeof agent.peermeshManifestUrl === "string" && agent.peermeshManifestUrl.trim().length > 0) {
    pointers.push({ name: "peermesh.manifest", value: agent.peermeshManifestUrl.trim() })
  }

  if (typeof agent.atprotoHandle === "string" && agent.atprotoHandle.trim().length > 0) {
    pointers.push({
      name: "atproto.profile",
      value: `https://bsky.app/profile/${agent.atprotoHandle.trim()}`,
    })
  }

  return pointers
}

function identityClaimsFromAgent(agent: typeof agents.$inferSelect): ManifestClaim[] {
  const claims: ManifestClaim[] = []

  if (typeof agent.peermeshHandle === "string" && agent.peermeshHandle.trim().length > 0) {
    claims.push({ name: "identity.peermesh.handle", value: agent.peermeshHandle.trim() })
  }
  if (typeof agent.peermeshDid === "string" && agent.peermeshDid.trim().length > 0) {
    claims.push({ name: "identity.peermesh.did", value: agent.peermeshDid.trim() })
  }
  if (typeof agent.atprotoHandle === "string" && agent.atprotoHandle.trim().length > 0) {
    claims.push({ name: "identity.atproto.handle", value: agent.atprotoHandle.trim() })
  }
  if (typeof agent.atprotoDid === "string" && agent.atprotoDid.trim().length > 0) {
    claims.push({ name: "identity.atproto.did", value: agent.atprotoDid.trim() })
  }

  return claims
}

async function ownerPublishingEnabled(ownerId: string): Promise<boolean> {
  const owner = await db.query.agents.findFirst({
    where: and(eq(agents.id, ownerId), isNull(agents.deletedAt)),
  })
  if (!owner) return false
  const ownerMeta = (owner.metadata ?? {}) as Record<string, unknown>
  if (owner.type === "person") return manifestOptIn(ownerMeta)
  const creatorId = typeof ownerMeta.creatorId === "string" ? ownerMeta.creatorId : null
  if (!creatorId) return false
  const creator = await db.query.agents.findFirst({
    where: and(eq(agents.id, creatorId), isNull(agents.deletedAt)),
  })
  return manifestOptIn((creator?.metadata ?? {}) as Record<string, unknown>)
}

export async function buildPersonUniversalManifest(id: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
  })
  if (!agent || agent.type !== "person") return null
  if (!canPublishEntity("universal_manifest", "person", agent.visibility)) return null

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  if (!manifestOptIn(metadata)) return null

  const user = agentToUser(serializeAgent(agent))
  const canonicalUrl = absoluteUrl(`/profile/${user.username || user.id}`)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/person/${id}`,
    [
      ...pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/person/${id}`),
      ...identityPointersFromAgent(agent),
    ],
    [
      ...baseClaims("person"),
      { name: "profile.username", value: user.username },
      { name: "profile.displayName", value: user.name },
      ...identityClaimsFromAgent(agent),
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          name: user.name,
          username: user.username,
          bio: user.bio || undefined,
          avatar: user.avatar || undefined,
          chapterTags: user.chapterTags ?? [],
          skills: user.skills ?? [],
        },
      },
    ],
  )
}

export async function buildOrganizationUniversalManifest(id: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
  })
  if (!agent || agent.type !== "organization") return null
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  const kind = inferGroupPublicationKind(metadata)
  if (!canPublishEntity("universal_manifest", kind, agent.visibility)) return null
  const creatorId = typeof metadata.creatorId === "string" ? metadata.creatorId : null
  if (!creatorId || !(await ownerPublishingEnabled(creatorId))) return null

  const group = agentToGroup(serializeAgent(agent))
  const path = kind === "ring" ? `/rings/${group.id}` : `/groups/${group.id}`
  const canonicalUrl = absoluteUrl(path)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/organization/${id}`,
    [
      ...pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/organization/${id}`),
      ...identityPointersFromAgent(agent),
    ],
    [
      ...baseClaims("organization"),
      { name: "profile.kind", value: kind },
      { name: "profile.displayName", value: group.name },
      ...identityClaimsFromAgent(agent),
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          name: group.name,
          description: group.description || undefined,
          image: group.image || undefined,
          chapterTags: group.chapterTags ?? [],
          tags: group.tags ?? [],
          kind,
        },
      },
    ],
  )
}

export async function buildProjectUniversalManifest(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource) return null
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const isProject = resource.type === "project" || String(metadata.resourceKind ?? "").toLowerCase() === "project"
  if (!isProject || !canPublishEntity("universal_manifest", "project", resource.visibility)) return null
  if (!(await ownerPublishingEnabled(resource.ownerId))) return null
  const canonicalUrl = absoluteUrl(`/projects/${resource.id}`)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/project/${id}`,
    pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/project/${id}`),
    [
      ...baseClaims("project"),
      { name: "profile.displayName", value: resource.name },
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          name: resource.name,
          description: resource.description || undefined,
          tags: resource.tags ?? [],
          chapterTags: Array.isArray(metadata.chapterTags) ? metadata.chapterTags : [],
        },
      },
    ],
  )
}

export async function buildOfferUniversalManifest(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource) return null
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const isOffer =
    typeof metadata.listingType === "string" ||
    String(metadata.listingKind ?? "").toLowerCase() === "marketplace-listing"
  if (!isOffer || !canPublishEntity("universal_manifest", "offer", resource.visibility)) return null
  if (!(await ownerPublishingEnabled(resource.ownerId))) return null

  const listing = resourceToMarketplaceListing(serializeResource(resource))
  const canonicalUrl = absoluteUrl(`/marketplace/${resource.id}`)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/offer/${id}`,
    pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/offer/${id}`),
    [
      ...baseClaims("offer"),
      { name: "profile.displayName", value: listing.title },
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          name: listing.title,
          description: listing.description || undefined,
          price: listing.price,
          currency: listing.currency || "USD",
          category: listing.category || undefined,
          type: listing.type || undefined,
        },
      },
    ],
  )
}

export async function buildEventUniversalManifest(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource) return null
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const isEvent =
    resource.type === "event" ||
    String(metadata.entityType ?? "").toLowerCase() === "event" ||
    String(metadata.resourceKind ?? "").toLowerCase() === "event"
  if (!isEvent || !canPublishEntity("universal_manifest", "event", resource.visibility)) return null
  if (!(await ownerPublishingEnabled(resource.ownerId))) return null

  const event = agentToEvent({
    id: resource.id,
    name: resource.name,
    type: "event",
    description: resource.description,
    email: null,
    image: null,
    metadata,
    parentId: typeof metadata.groupId === "string" ? metadata.groupId : null,
    pathIds: Array.isArray(metadata.chapterTags) ? (metadata.chapterTags as string[]) : [],
    depth: 0,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
  })
  const canonicalUrl = absoluteUrl(`/events/${resource.id}`)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/event/${id}`,
    pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/event/${id}`),
    [
      ...baseClaims("event"),
      { name: "profile.displayName", value: event.name },
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          name: event.name,
          description: event.description || undefined,
          start: event.timeframe?.start,
          end: event.timeframe?.end,
          location: event.location || undefined,
          chapterTags: event.chapterTags ?? [],
        },
      },
    ],
  )
}

export async function buildPostUniversalManifest(id: string) {
  const resource = await db.query.resources.findFirst({
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
  })
  if (!resource) return null
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const isPost =
    resource.type === "post" ||
    resource.type === "note" ||
    String(metadata.entityType ?? "").toLowerCase() === "post"
  if (!isPost || !canPublishEntity("universal_manifest", "post", resource.visibility)) return null
  if (!(await ownerPublishingEnabled(resource.ownerId))) return null
  const post = resourceToPost(serializeResource(resource))
  const canonicalUrl = absoluteUrl(`/posts/${resource.id}`)
  return buildBaseManifest(
    id,
    canonicalUrl,
    `/api/universal-manifest/post/${id}`,
    pointersFromMetadata(metadata, canonicalUrl, `/api/universal-manifest/post/${id}`),
    [
      ...baseClaims("post"),
      { name: "profile.displayName", value: post.title || post.author.name || "Post" },
    ],
    baseConsents(),
    [
      {
        name: "publicProfile",
        value: {
          title: post.title || undefined,
          content: post.content,
          postType: post.postType,
          linkedOfferingId: post.linkedOfferingId || undefined,
          dealPriceCents: post.dealPriceCents,
        },
      },
    ],
  )
}
