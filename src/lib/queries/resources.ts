/**
 * Resource query module for semantic graph content.
 *
 * Purpose:
 * - Provides read-side data-access helpers for resource entities.
 * - Applies shared visibility constraints like soft-delete filtering.
 * - Supports ownership, grouping, listing, semantic, and scoped retrieval patterns.
 *
 * Key exports:
 * - Single/batch fetch: `getResource`, `getResourcesByIds`, `getAllResources`.
 * - Filtered reads: `getResourcesByType`, `getResourcesByOwner`, `getResourcesByTag`.
 * - Scope/listing reads: `getResourcesForGroup`, `getResourcesInScope`, `getMarketplaceListings`.
 * - Discovery reads: `getPublicResources`, `searchResourcesBySemantic`.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for Drizzle database access.
 * - `drizzle-orm` query operators and SQL templating.
 * - PostgreSQL JSONB/vector operators for metadata and semantic search.
 */

import { db } from "@/db";
import { resources, ledger } from "@/db/schema";
import { eq, and, isNull, desc, sql, inArray } from "drizzle-orm";
import type { Resource, ResourceType } from "@/db/schema";
import type {
  Document,
  JobShift,
  Task,
  UserBadge,
  TrainingModule,
  LiveClass,
  ProjectRecord,
  ProjectDomain,
  ProjectMilestone,
  ProjectResource,
} from "@/types/domain";

/**
 * Maps a raw SQL row (`snake_case` columns) into the typed `Resource` shape.
 *
 * Used for raw SQL execution paths where ORM relation mappers are bypassed.
 */
function rowToResource(row: Record<string, unknown>): Resource {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as ResourceType,
    description: (row.description ?? null) as string | null,
    content: (row.content ?? null) as string | null,
    contentType: (row.content_type ?? null) as string | null,
    url: (row.url ?? null) as string | null,
    storageKey: (row.storage_key ?? null) as string | null,
    storageProvider: (row.storage_provider ?? "minio") as string | null,
    fileSize: (row.file_size ?? null) as number | null,
    ownerId: row.owner_id as string,
    isPublic: (row.is_public ?? false) as boolean,
    visibility: (row.visibility ?? "members") as string,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    tags: (row.tags ?? null) as string[] | null,
    embedding: row.embedding ?? null,
    location: row.location ?? null,
    deletedAt: (row.deleted_at ?? null) as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  } as Resource;
}

/**
 * Returns a single non-deleted resource by id, including its owner relation.
 *
 * @param id Resource UUID.
 * @returns Matching resource with owner or `undefined`.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const resource = await getResource(resourceId);
 * ```
 */
export async function getResource(id: string) {
  return await db.query.resources.findFirst({
    // Business rule: all read queries in this module exclude soft-deleted rows.
    where: and(eq(resources.id, id), isNull(resources.deletedAt)),
    with: {
      owner: true,
    },
  });
}

/**
 * Returns recent non-deleted resources filtered by resource type.
 *
 * @param type Resource type discriminator.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Matching resources with owner relation loaded.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const docs = await getResourcesByType("document", 25);
 * ```
 */
export async function getResourcesByType(
  type: ResourceType,
  limit = 50
) {
  return await db.query.resources.findMany({
    where: and(eq(resources.type, type), isNull(resources.deletedAt)),
    limit,
    orderBy: [desc(resources.createdAt)],
    with: {
      owner: true,
    },
  });
}

/**
 * Returns resources owned by a specific agent.
 *
 * @param ownerId Owner agent UUID.
 * @returns Owner's non-deleted resources ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const mine = await getResourcesByOwner(agentId);
 * ```
 */
export async function getResourcesByOwner(ownerId: string) {
  return await db.query.resources.findMany({
    where: and(eq(resources.ownerId, ownerId), isNull(resources.deletedAt)),
    orderBy: [desc(resources.createdAt)],
  });
}

/**
 * Returns resources owned by a specific agent, filtered by type.
 *
 * @param ownerId Owner agent UUID.
 * @param type Resource type discriminator.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Matching non-deleted resources ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const skills = await getResourcesByOwnerAndType(userId, "skill");
 * ```
 */
export async function getResourcesByOwnerAndType(
  ownerId: string,
  type: ResourceType,
  limit = 50
) {
  return await db.query.resources.findMany({
    where: and(
      eq(resources.ownerId, ownerId),
      eq(resources.type, type),
      isNull(resources.deletedAt)
    ),
    limit,
    orderBy: [desc(resources.createdAt)],
  });
}

/**
 * Returns resources associated with a group/ring/family identity.
 *
 * Association strategy:
 * - Direct ownership (`owner_id = groupId`).
 * - Metadata links (`metadata.groupDbId` or `metadata.groupId`) for seeded/live records.
 *
 * @param groupId Group identifier (UUID string).
 * @param limit Max rows to return. Defaults to `200`.
 * @returns Matching non-deleted resources ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const groupResources = await getResourcesForGroup(groupId, 100);
 * ```
 */
export async function getResourcesForGroup(groupId: string, limit = 200): Promise<Resource[]> {
  const result = await db.execute(sql`
    SELECT r.*
    FROM resources r
    WHERE r.deleted_at IS NULL
      AND (
        r.owner_id = ${groupId}::uuid
        OR r.metadata->>'groupDbId' = ${groupId}
        OR r.metadata->>'groupId' = ${groupId}
        OR r.metadata->'groupTags' @> ${JSON.stringify([groupId])}::jsonb
      )
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToResource);
}

/**
 * Returns resources that contain a specific tag in the `tags` array column.
 *
 * @param tag Tag to match.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Tagged non-deleted resources ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const tagged = await getResourcesByTag("water", 30);
 * ```
 */
export async function getResourcesByTag(tag: string, limit = 50) {
  const result = await db.execute(sql`
    SELECT *
    FROM resources
    WHERE deleted_at IS NULL
    AND ${tag} = ANY(tags)
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToResource);
}

/**
 * Returns resources marked public and not soft deleted.
 *
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Public resources with owner relation loaded.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const publicFeed = await getPublicResources(20);
 * ```
 */
export async function getPublicResources(limit = 50) {
  return await db.query.resources.findMany({
    where: and(
      eq(resources.isPublic, true),
      isNull(resources.deletedAt),
      sql`(${resources.metadata}->>'eventId') IS NULL`,
      sql`(${resources.metadata}->>'groupId') IS NULL`
    ),
    limit,
    orderBy: [desc(resources.createdAt)],
    with: {
      owner: true,
    },
  });
}

/**
 * Returns active marketplace listings derived from resource metadata.
 *
 * Inclusion rules:
 * - `metadata.listingType` must exist.
 * - `metadata.status` must be either missing or equal to `"active"`.
 *
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Listing resources augmented with owner display fields.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const listings = await getMarketplaceListings(40);
 * ```
 */
export async function getMarketplaceListings(limit = 50) {
  const result = await db.execute(sql`
    SELECT r.*, a.name as owner_name, a.image as owner_image
    FROM resources r
    JOIN agents a ON r.owner_id = a.id
    WHERE r.deleted_at IS NULL
    AND r.metadata->>'listingType' IS NOT NULL
    AND (r.metadata->>'status' IS NULL OR r.metadata->>'status' = 'active')
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map((row) => ({
    ...rowToResource(row),
    owner_name: row.owner_name as string,
    owner_image: row.owner_image as string | null,
  }));
}

/**
 * Returns resources owned by agents inside a hierarchy scope.
 *
 * Scope matching includes direct parent ownership and ancestor path membership.
 *
 * @param scopeId Scope agent UUID.
 * @param options Optional query settings.
 * @param options.type Optional resource type filter.
 * @param options.limit Max rows to return. Defaults to `50`.
 * @returns Matching resources ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const scoped = await getResourcesInScope(scopeId, { type: "image", limit: 25 });
 * ```
 */
export async function getResourcesInScope(
  scopeId: string,
  options?: { type?: ResourceType; limit?: number }
) {
  const { type, limit = 50 } = options ?? {};

  // Parameterized fragment avoids constructing untrusted SQL strings manually.
  const typeFilter = type ? sql`AND r.type = ${type}` : sql``;

  const result = await db.execute(sql`
    SELECT r.*
    FROM resources r
    JOIN agents a ON r.owner_id = a.id
    WHERE r.deleted_at IS NULL
    AND a.deleted_at IS NULL
    AND (a.parent_id = ${scopeId} OR ${scopeId} = ANY(a.path_ids))
    ${typeFilter}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToResource);
}

/**
 * Performs semantic nearest-neighbor search over resource embeddings.
 *
 * Uses PostgreSQL vector cosine-distance ordering (`<=>`) with ascending distance.
 *
 * @param queryEmbedding Embedding vector for the search query.
 * @param limit Max rows to return. Defaults to `20`.
 * @returns Nearest non-deleted resources that have embeddings.
 * @throws Propagates database/connection/vector extension errors from the query.
 * @example
 * ```ts
 * const nearest = await searchResourcesBySemantic(embedding, 15);
 * ```
 */
export async function searchResourcesBySemantic(
  queryEmbedding: number[],
  limit = 20
) {
  const result = await db.execute(sql`
    SELECT *
    FROM resources
    WHERE embedding IS NOT NULL
    AND deleted_at IS NULL
    ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToResource);
}

/**
 * Returns non-deleted resources whose ids are in the provided list.
 *
 * @param ids Resource UUID list.
 * @returns Matching resources, or `[]` when input is empty.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const resources = await getResourcesByIds([id1, id2]);
 * ```
 */
export async function getResourcesByIds(ids: string[]): Promise<Resource[]> {
  // Empty-list guard avoids issuing an `IN ()` style query.
  if (ids.length === 0) return [];

  return await db.query.resources.findMany({
    where: and(
      inArray(resources.id, ids),
      isNull(resources.deletedAt)
    ),
  });
}

/**
 * Returns resources with optional type filtering and offset pagination.
 *
 * @param options Optional filter and pagination options.
 * @param options.type Optional resource type constraint.
 * @param options.limit Max rows to return. Defaults to `50`.
 * @param options.offset Pagination offset. Defaults to `0`.
 * @returns Matching resources ordered newest first with owner relation loaded.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const page = await getAllResources({ type: "document", limit: 50, offset: 100 });
 * ```
 */
export async function getAllResources(options?: {
  type?: ResourceType;
  limit?: number;
  offset?: number;
}) {
  const { type, limit = 50, offset = 0 } = options ?? {};

  // Configuration pattern: optional clauses are appended, then spread into `and(...)`.
  const conditions = [isNull(resources.deletedAt)];
  if (type) {
    conditions.push(eq(resources.type, type));
  }

  return await db.query.resources.findMany({
    where: and(...conditions),
    limit,
    offset,
    orderBy: [desc(resources.createdAt)],
    with: {
      owner: true,
    },
  });
}

// ─── Resource → Domain Type Mappers ──────────────────────────────────────────

/**
 * Maps a Resource with type 'document' to a domain Document.
 *
 * @param resource Source resource row.
 * @param fallbackGroupId Group ID to use when metadata doesn't specify one.
 */
export function resourceToDocument(resource: Resource, fallbackGroupId = ""): Document {
  const m = (resource.metadata ?? {}) as Record<string, unknown>;
  return {
    id: resource.id,
    title: resource.name,
    description: resource.description ?? "",
    content: resource.content ?? "",
    createdAt: resource.createdAt instanceof Date ? resource.createdAt.toISOString() : String(resource.createdAt),
    updatedAt: resource.updatedAt instanceof Date ? resource.updatedAt.toISOString() : String(resource.updatedAt),
    createdBy: (m.createdBy as string) ?? resource.ownerId,
    groupId: (m.groupId as string) ?? (m.groupDbId as string) ?? fallbackGroupId,
    tags: resource.tags ?? undefined,
    category: (m.category as string) ?? undefined,
    showOnAbout: m.showOnAbout === true,
  };
}

/**
 * Maps a Resource with type 'shift' to a domain JobShift.
 *
 * Top-level Resource fields map to standard properties; domain-specific
 * fields are extracted from the JSONB `metadata` column.
 */
function resourceToJobShift(resource: Resource): JobShift {
  const m = (resource.metadata ?? {}) as Record<string, unknown>;
  return {
    id: resource.id,
    title: resource.name,
    description: resource.description ?? "",
    groupId: (m.groupId as string) ?? "",
    createdBy: (m.createdBy as string) ?? resource.ownerId,
    category: (m.category as string) ?? "",
    location: (m.location as string) ?? "",
    duration: (m.duration as string) ?? "",
    totalPoints: (m.totalPoints as number) ?? 0,
    priority: (m.priority as JobShift["priority"]) ?? "medium",
    status: (m.status as JobShift["status"]) ?? "open",
    requiredBadges: (m.requiredBadges as string[]) ?? [],
    tasks: (m.tasks as Task[]) ?? [],
    assignees: (m.assignees as string[]) ?? [],
    maxAssignees: (m.maxAssignees as number) ?? 1,
    deadline: m.deadline as string | undefined,
    createdAt: resource.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: resource.updatedAt?.toISOString() ?? new Date().toISOString(),
    comments: (m.comments as JobShift["comments"]) ?? [],
  };
}

/**
 * Maps a Resource with type 'badge' to a domain UserBadge.
 */
function resourceToUserBadge(resource: Resource): UserBadge {
  const m = (resource.metadata ?? {}) as Record<string, unknown>;
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description ?? "",
    icon: (m.icon as string) ?? "",
    level: (m.level as UserBadge["level"]) ?? "beginner",
    category: m.category as string | undefined,
    requirements: m.requirements as string[] | undefined,
    trainingModules: m.trainingModules as TrainingModule[] | undefined,
    liveClass: m.liveClass as LiveClass | undefined,
    createdAt: resource.createdAt?.toISOString(),
    issuedBy: m.issuedBy as string | undefined,
    jobsUnlocked: m.jobsUnlocked as string[] | undefined,
    holders: m.holders as string[] | undefined,
  };
}

/**
 * Maps a Resource with type 'project' to a domain ProjectRecord.
 */
function resourceToProjectRecord(resource: Resource): ProjectRecord {
  const m = (resource.metadata ?? {}) as Record<string, unknown>;
  return {
    id: resource.id,
    title: resource.name,
    description: resource.description ?? "",
    longDescription: m.longDescription as string | undefined,
    vision: m.vision as string | undefined,
    objectives: m.objectives as string[] | undefined,
    groupId: (m.groupId as string) ?? "",
    createdBy: (m.createdBy as string) ?? resource.ownerId,
    category: (m.category as string) ?? "",
    status: (m.status as ProjectRecord["status"]) ?? "planning",
    priority: (m.priority as ProjectRecord["priority"]) ?? "medium",
    jobs: (m.jobs as string[]) ?? [],
    createdAt: resource.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: resource.updatedAt?.toISOString() ?? new Date().toISOString(),
    deadline: m.deadline as string | undefined,
    totalPoints: m.totalPoints as number | undefined,
    completionPercentage: m.completionPercentage as number | undefined,
    tags: (m.tags as string[]) ?? [],
    teamLeads: (m.teamLeads as string[]) ?? [],
    domains: m.domains as ProjectDomain[] | undefined,
    milestones: m.milestones as ProjectMilestone[] | undefined,
    resources: m.resources as ProjectResource[] | undefined,
    location: m.location as string | undefined,
    budget: m.budget as number | undefined,
    website: m.website as string | undefined,
    socialLinks: m.socialLinks as { platform: string; url: string }[] | undefined,
  };
}

// ─── Domain-Typed Query Functions ────────────────────────────────────────────

/**
 * Returns all job shifts from the resources table, mapped to domain type.
 *
 * @param limit Max rows to return. Defaults to `100`.
 * @returns JobShift array derived from 'shift' resources.
 */
export async function getShifts(limit = 100): Promise<JobShift[]> {
  const rows = await getResourcesByType("shift", limit);
  return rows.map(resourceToJobShift);
}

/**
 * Returns all badge definitions from the resources table, mapped to domain type.
 *
 * @param limit Max rows to return. Defaults to `100`.
 * @returns UserBadge array derived from 'badge' resources.
 */
export async function getBadgeDefinitions(limit = 100): Promise<UserBadge[]> {
  const rows = await getResourcesByType("badge", limit);
  return rows.map(resourceToUserBadge);
}

/**
 * Returns all projects from the resources table, mapped to domain type.
 *
 * @param limit Max rows to return. Defaults to `100`.
 * @returns ProjectRecord array derived from 'project' resources.
 */
export async function getProjects(limit = 100): Promise<ProjectRecord[]> {
  const rows = await getResourcesByType("project", limit);
  return rows.map(resourceToProjectRecord);
}

/**
 * Returns documents for a group, mapped to the domain Document type.
 *
 * Fetches resources associated with the group and filters to type 'document'.
 *
 * @param groupId Group identifier (UUID string).
 * @param limit Max rows to return. Defaults to `200`.
 * @returns Document array derived from 'document' resources in the group.
 */
export async function getDocumentsForGroup(groupId: string, limit = 200): Promise<Document[]> {
  const groupResources = await getResourcesForGroup(groupId, limit);
  return groupResources
    .filter((r) => r.type === "document")
    .map((r) => resourceToDocument(r, groupId));
}

/**
 * Returns the transcript document associated with an event, if one exists.
 *
 * The transcript is a regular group-owned document resource tagged with
 * `resourceSubtype = event-transcript` and `metadata.eventId`.
 */
export async function getEventTranscriptDocument(eventId: string): Promise<Document | null> {
  const result = await db.execute(sql`
    SELECT r.*
    FROM resources r
    WHERE r.deleted_at IS NULL
      AND r.type = 'document'
      AND r.metadata->>'resourceSubtype' = 'event-transcript'
      AND r.metadata->>'eventId' = ${eventId}
    ORDER BY r.updated_at DESC
    LIMIT 1
  `);

  const row = (result as Record<string, unknown>[])[0];
  if (!row) return null;

  const resource = rowToResource(row);
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  return resourceToDocument(resource, typeof metadata.groupId === "string" ? metadata.groupId : "");
}

// ─── Badge Helper Functions (Ledger-Backed) ──────────────────────────────────

/**
 * Returns all badge definitions that a user currently holds, based on
 * active 'assign' edges in the ledger table.
 *
 * @param userId Agent UUID of the user.
 * @returns UserBadge array for badges assigned to the user.
 */
export async function getUserBadges(userId: string): Promise<UserBadge[]> {
  const result = await db.execute(sql`
    SELECT r.*
    FROM ledger l
    JOIN resources r ON l.resource_id = r.id
    WHERE l.subject_id = ${userId}::uuid
      AND l.verb = 'assign'
      AND l.is_active = true
      AND r.type = 'badge'
      AND r.deleted_at IS NULL
  `);

  return (result as Record<string, unknown>[]).map((row) =>
    resourceToUserBadge(rowToResource(row))
  );
}

/**
 * Returns the badge IDs that a user currently holds.
 *
 * @param userId Agent UUID of the user.
 * @returns Array of badge resource IDs.
 */
export async function getUserBadgeIds(userId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT l.resource_id
    FROM ledger l
    JOIN resources r ON l.resource_id = r.id
    WHERE l.subject_id = ${userId}::uuid
      AND l.verb = 'assign'
      AND l.is_active = true
      AND r.type = 'badge'
      AND r.deleted_at IS NULL
  `);

  return (result as Record<string, unknown>[]).map(
    (row) => row.resource_id as string
  );
}

/**
 * Checks whether a user holds a specific badge.
 *
 * @param userId Agent UUID of the user.
 * @param badgeId Resource UUID of the badge.
 * @returns `true` if an active assignment edge exists.
 */
export async function userHasBadge(
  userId: string,
  badgeId: string
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM ledger l
    JOIN resources r ON l.resource_id = r.id
    WHERE l.subject_id = ${userId}::uuid
      AND l.resource_id = ${badgeId}::uuid
      AND l.verb = 'assign'
      AND l.is_active = true
      AND r.type = 'badge'
      AND r.deleted_at IS NULL
    LIMIT 1
  `);

  return (result as unknown[]).length > 0;
}

/**
 * Checks whether a user holds at least one of the required badges.
 *
 * @param userId Agent UUID of the user.
 * @param requiredBadges Array of badge resource IDs.
 * @returns `true` if the user has any of the listed badges, or if the list is empty.
 */
export async function userHasRequiredBadges(
  userId: string,
  requiredBadges: string[]
): Promise<boolean> {
  if (!requiredBadges || requiredBadges.length === 0) return true;

  const userBadgeIdList = await getUserBadgeIds(userId);
  return requiredBadges.some((badge) => userBadgeIdList.includes(badge));
}
