/**
 * Agent query module for the semantic graph.
 *
 * Purpose:
 * - Centralizes data-access helpers for reading agent records and related feeds.
 * - Enforces shared read rules like soft-delete filtering (`deleted_at IS NULL`).
 * - Supports hierarchical lookups (`parent_id`, `path_ids`, and metadata chapter tags).
 *
 * Key exports:
 * - Identity lookups: `getAgent`, `getAgentByName`, `getAgentByEmail`, `getAgentByUsername`.
 * - Collection queries: `getAgentsByType`, `getAgentsNearby`, `searchAgents`.
 * - Hierarchy queries: `getAgentChildren`, `getAgentWithChildren`, `getAgentsInScope`, `searchAgentsInScope`.
 * - Group/scope helpers: `getGroupMembers`, `getPlacesByPlaceType`.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for Drizzle database access and table definitions.
 * - `drizzle-orm` operators and SQL template tags for composable and raw SQL queries.
 * - `toContainsLikePattern` for escaped `ILIKE` contains matching.
 */

import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import { eq, and, or, ilike, isNull, sql, desc, inArray } from "drizzle-orm";
import type { Agent, AgentType } from "@/db/schema";
import { toContainsLikePattern } from "@/lib/sql-like";

/**
 * Maps a raw SQL row (`snake_case` columns) into the typed `Agent` shape.
 *
 * This adapter is used for `db.execute(...)` queries that bypass Drizzle's model mapping.
 */
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as AgentType,
    description: (row.description ?? null) as string | null,
    email: (row.email ?? null) as string | null,
    passwordHash: (row.password_hash ?? null) as string | null,
    emailVerified: (row.email_verified ?? null) as Date | null,
    visibility: (row.visibility ?? "locale") as string,
    groupPasswordHash: (row.group_password_hash ?? null) as string | null,
    image: (row.image ?? null) as string | null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    parentId: (row.parent_id ?? null) as string | null,
    pathIds: (row.path_ids ?? null) as string[] | null,
    depth: (row.depth ?? 0) as number,
    location: row.location ?? null,
    embedding: row.embedding ?? null,
    deletedAt: (row.deleted_at ?? null) as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  } as Agent;
}

/**
 * Returns a single non-deleted agent by its primary identifier.
 *
 * @param id Agent UUID.
 * @returns Matching `Agent` or `undefined` when no active record exists.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const agent = await getAgent("9d9b2a3e-2ff8-49e9-a944-ead67c888111");
 * ```
 */
export async function getAgent(id: string): Promise<Agent | undefined> {
  return await db.query.agents.findFirst({
    // Business rule: soft-deleted agents are excluded from all read paths.
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
  });
}

/**
 * Returns a single non-deleted agent by case-insensitive name match.
 *
 * @param name Agent name to match.
 * @returns Matching `Agent` or `undefined` when absent.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const agent = await getAgentByName("river collective");
 * ```
 */
export async function getAgentByName(name: string): Promise<Agent | undefined> {
  return await db.query.agents.findFirst({
    // `ilike` performs case-insensitive comparison at the database layer.
    where: and(ilike(agents.name, name), isNull(agents.deletedAt)),
  });
}

/**
 * Returns a single non-deleted agent by exact email value.
 *
 * @param email Email address to match.
 * @returns Matching `Agent` or `undefined` when absent.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const agent = await getAgentByEmail("owner@example.org");
 * ```
 */
export async function getAgentByEmail(email: string): Promise<Agent | undefined> {
  return await db.query.agents.findFirst({
    where: and(eq(agents.email, email), isNull(agents.deletedAt)),
  });
}

/**
 * Returns a person agent by `metadata.username` using case-insensitive exact comparison.
 *
 * @param username Username candidate from user input.
 * @returns Matching person `Agent` or `undefined` when no match exists.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const userAgent = await getAgentByUsername("cam");
 * ```
 */
export async function getAgentByUsername(username: string): Promise<Agent | undefined> {
  const normalized = username.trim().toLowerCase();
  // Reject empty input after normalization to avoid unnecessary DB traffic.
  if (!normalized) return undefined;

  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE deleted_at IS NULL
      AND type = 'person'
      AND (
        lower(coalesce(metadata->>'username', '')) = ${normalized}
        OR lower(split_part(coalesce(email, ''), '@', 1)) = ${normalized}
        OR (
          coalesce(metadata->>'username', '') = ''
          AND trim(both '-' from regexp_replace(
            regexp_replace(lower(coalesce(name, '')), '[^a-z0-9-]+', '-', 'g'),
            '-+',
            '-',
            'g'
          )) = ${normalized}
        )
      )
    LIMIT 1
  `);

  const [row] = result as Record<string, unknown>[];
  return row ? rowToAgent(row) : undefined;
}

/**
 * Returns recent non-deleted agents of a specific schema type.
 *
 * @param type Agent type discriminator.
 * @param limit Max rows to return, newest first. Defaults to `50`.
 * @returns Array of matching agents.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const organizations = await getAgentsByType("organization", 25);
 * ```
 */
export async function getAgentsByType(
  type: AgentType,
  limit = 50
): Promise<Agent[]> {
  return await db.query.agents.findMany({
    where: and(eq(agents.type, type), isNull(agents.deletedAt)),
    limit,
    orderBy: [desc(agents.createdAt)],
  });
}

/**
 * Returns non-deleted agents with a known location inside a geographic radius.
 *
 * Uses PostGIS distance operators against geography values for meter-based calculations.
 *
 * @param lat Latitude in decimal degrees.
 * @param lng Longitude in decimal degrees.
 * @param radiusMeters Search radius in meters. Defaults to `5000`.
 * @returns Agents ordered by nearest distance first.
 * @throws Propagates database/connection/PostGIS errors from the underlying query.
 * @example
 * ```ts
 * const nearby = await getAgentsNearby(45.523, -122.676, 2000);
 * ```
 */
export async function getAgentsNearby(
  lat: number,
  lng: number,
  radiusMeters: number = 5000
) {
  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE location IS NOT NULL
    AND deleted_at IS NULL
    AND ST_DWithin(
      location::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${radiusMeters}
    )
    ORDER BY ST_Distance(
      location::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
    )
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Performs a case-insensitive name search with escaped contains semantics.
 *
 * @param query Free-text name query.
 * @param limit Max rows to return. Defaults to `20`.
 * @returns Matching non-deleted agents.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const matches = await searchAgents("river", 10);
 * ```
 */
export async function searchAgents(query: string, limit = 20): Promise<Agent[]> {
  // Escape wildcard tokens (`%`, `_`, `\`) before using LIKE to avoid pattern injection.
  const escaped = toContainsLikePattern(query);
  return await db.query.agents.findMany({
    where: and(
      ilike(agents.name, escaped),
      isNull(agents.deletedAt)
    ),
    limit,
  });
}

/**
 * Returns direct child agents for a given parent agent id.
 *
 * @param parentId Parent agent UUID.
 * @returns Child agents that are not soft deleted.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const members = await getAgentChildren(groupId);
 * ```
 */
export async function getAgentChildren(parentId: string): Promise<Agent[]> {
  return await db.query.agents.findMany({
    where: and(eq(agents.parentId, parentId), isNull(agents.deletedAt)),
  });
}

/**
 * Returns one non-deleted agent including its `children` relation.
 *
 * @param id Agent UUID.
 * @returns Agent with eager-loaded children, or `undefined` if missing.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const tree = await getAgentWithChildren(groupId);
 * ```
 */
export async function getAgentWithChildren(id: string) {
  return await db.query.agents.findFirst({
    where: and(eq(agents.id, id), isNull(agents.deletedAt)),
    with: {
      children: true,
    },
  });
}

/**
 * Returns recent ledger entries where the agent appears as subject or object.
 *
 * @param agentId Agent UUID.
 * @param limit Max feed entries to return, newest first. Defaults to `50`.
 * @returns Matching ledger entries ordered by descending timestamp.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const feed = await getAgentFeed(agentId, 25);
 * ```
 */
export async function getAgentFeed(agentId: string, limit = 50) {
  return await db.query.ledger.findMany({
    where: or(
      eq(ledger.subjectId, agentId),
      eq(ledger.objectId, agentId)
    ),
    limit,
    orderBy: [desc(ledger.timestamp)],
  });
}

/**
 * Reads an agent reputation score from metadata.
 *
 * @param agentId Agent UUID.
 * @returns Numeric reputation value or `0` when absent/non-numeric.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const score = await getAgentReputation(agentId);
 * ```
 */
export async function getAgentReputation(agentId: string): Promise<number> {
  const agent = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (agent.length === 0) return 0;

  const metadata = (agent[0].metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.reputation === "number" ? metadata.reputation : 0;
}

/**
 * Returns people who are members of a group.
 *
 * Membership resolution strategy:
 * 1. Prefer structural hierarchy (`parent_id = groupId` and type `person`).
 * 2. Fallback to active ledger verbs (`belong`/`join`) pointing at the group.
 *
 * @param groupId Group/organization agent UUID.
 * @returns Member agents as `Agent[]`.
 * @throws Propagates database/connection errors from the underlying queries.
 * @example
 * ```ts
 * const members = await getGroupMembers(groupId);
 * ```
 */
export async function getGroupMembers(groupId: string): Promise<Agent[]> {
  // Members are modeled as children of the group agent or via ledger membership entries
  // First try hierarchical approach
  const children = await db.query.agents.findMany({
    where: and(
      eq(agents.parentId, groupId),
      eq(agents.type, "person"),
      isNull(agents.deletedAt)
    ),
  });

  if (children.length > 0) return children;

  // Fallback supports legacy/event-sourced membership when hierarchy links are unavailable.
  const membershipEntries = await db.query.ledger.findMany({
    where: and(
      eq(ledger.objectId, groupId),
      eq(ledger.objectType, "agent"),
      or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
      eq(ledger.isActive, true)
    ),
  });

  // De-duplicate IDs to avoid redundant `IN (...)` terms and repeated rows.
  const agentIds = new Set(membershipEntries.map((e) => e.subjectId));

  if (agentIds.size === 0) {
    const [group] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
      .limit(1);

    const creatorId =
      group?.metadata && typeof group.metadata === "object"
        ? (group.metadata as Record<string, unknown>).creatorId
        : null;

    if (typeof creatorId === "string" && creatorId.length > 0) {
      agentIds.add(creatorId);
    }
  }

  if (agentIds.size === 0) return [];

  return await db.query.agents.findMany({
    where: and(
      inArray(agents.id, [...agentIds]),
      isNull(agents.deletedAt)
    ),
  });
}

/**
 * Returns agents visible within a hierarchical scope.
 *
 * Scope matching is satisfied when an agent:
 * - is directly parented by the scope,
 * - has the scope in `path_ids`,
 * - or includes the scope in `metadata.chapterTags` (NLP-created entities).
 *
 * @param scopeId Scope agent UUID.
 * @param options Optional type/pagination options.
 * @param options.type Optional agent type filter.
 * @param options.limit Max rows. Defaults to `50`.
 * @param options.offset Offset for pagination. Defaults to `0`.
 * @returns Matching agents ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const visible = await getAgentsInScope(scopeId, { type: "person", limit: 25 });
 * ```
 */
export async function getAgentsInScope(
  scopeId: string,
  options?: { type?: AgentType; limit?: number; offset?: number }
): Promise<Agent[]> {
  const { type, limit = 50, offset = 0 } = options ?? {};

  // Optional SQL fragment for typed filtering; parameterized to avoid SQL injection.
  const typeFilter = type ? sql`AND type = ${type}` : sql``;

  // Match agents by hierarchy (parentId / pathIds) OR by chapterTags in metadata.
  // This enables locale-based filtering for entities created via the NLP flow
  // that store their locale association in metadata->'chapterTags'.
  // Convert to JSON array for PostgreSQL `@>` containment against JSONB metadata.
  const scopeJson = JSON.stringify([scopeId]);

  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE deleted_at IS NULL
    AND (
      parent_id = ${scopeId}
      OR ${scopeId} = ANY(path_ids)
      OR metadata->'chapterTags' @> ${scopeJson}::jsonb
    )
    ${typeFilter}
    ORDER BY created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Performs a scoped name search across hierarchy and chapter-tag membership.
 *
 * @param scopeId Scope agent UUID.
 * @param query Name query to match with `ILIKE`.
 * @param limit Max rows to return. Defaults to `20`.
 * @returns Matching scoped agents ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const results = await searchAgentsInScope(scopeId, "river");
 * ```
 */
export async function searchAgentsInScope(
  scopeId: string,
  query: string,
  limit = 20
): Promise<Agent[]> {
  const scopeJson = JSON.stringify([scopeId]);
  // Escaped pattern plus explicit ESCAPE clause prevents wildcard-control from user input.
  const escaped = toContainsLikePattern(query);

  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE deleted_at IS NULL
    AND (
      parent_id = ${scopeId}
      OR ${scopeId} = ANY(path_ids)
      OR metadata->'chapterTags' @> ${scopeJson}::jsonb
    )
    AND name ILIKE ${escaped} ESCAPE '\\'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Returns all non-deleted agents whose ids are included in the provided list.
 *
 * @param ids Agent UUID list.
 * @returns Matching agents. Returns an empty array when `ids` is empty.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const batch = await getAgentsByIds([id1, id2, id3]);
 * ```
 */
export async function getAgentsByIds(ids: string[]): Promise<Agent[]> {
  // Short-circuit empty `IN` lists to avoid unnecessary queries.
  if (ids.length === 0) return [];

  return await db.query.agents.findMany({
    where: and(
      inArray(agents.id, ids),
      isNull(agents.deletedAt)
    ),
  });
}

/**
 * Returns agents with optional type filtering and pagination.
 *
 * @param options Optional filter and pagination settings.
 * @param options.type Optional agent type constraint.
 * @param options.limit Max rows to return. Defaults to `50`.
 * @param options.offset Offset for pagination. Defaults to `0`.
 * @returns Matching non-deleted agents sorted by newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const page = await getAllAgents({ type: "organization", limit: 50, offset: 100 });
 * ```
 */
export async function getAllAgents(options?: {
  type?: AgentType;
  limit?: number;
  offset?: number;
}): Promise<Agent[]> {
  const { type, limit = 50, offset = 0 } = options ?? {};

  // Configuration pattern: build a reusable condition list then spread into `and(...)`.
  const conditions = [isNull(agents.deletedAt)];
  if (type) {
    conditions.push(eq(agents.type, type));
  }

  return await db.query.agents.findMany({
    where: and(...conditions),
    limit,
    offset,
    orderBy: [desc(agents.createdAt)],
  });
}

/**
 * Returns location-scope agents filtered by metadata `placeType`.
 *
 * Supports both legacy `type = 'place'` rows and current `type = 'organization'` rows.
 * Alias expansion is applied to preserve compatibility with historical naming
 * (`chapter`/`locale`, `basin`/`region`).
 *
 * @param placeType Canonical or alias place type value.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Matching place-like agents sorted by newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const chapters = await getPlacesByPlaceType("chapter", 30);
 * ```
 */
export async function getPlacesByPlaceType(
  placeType: string,
  limit = 50
): Promise<Agent[]> {
  /** Alias map for backward-compatible place type matching across old/new data models. */
  const aliases: Record<string, string[]> = {
    chapter: ["chapter", "locale"],
    locale: ["locale", "chapter"],
    basin: ["basin", "region"],
    region: ["region", "basin"],
    council: ["council"],
  };
  const placeTypes = aliases[placeType] ?? [placeType];
  const placeTypeFilter =
    placeTypes.length > 0
      ? sql.join(placeTypes.map((t) => sql`metadata->>'placeType' = ${t}`), sql` OR `)
      : sql`false`;
  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE deleted_at IS NULL
    AND type IN ('place', 'organization')
    AND (${placeTypeFilter})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Returns organization-type agents where the given user is a member, admin, or creator.
 *
 * Membership detection:
 * - `metadata.memberIds` JSON array contains the userId.
 * - `metadata.creatorId` matches the userId.
 * - `metadata.adminIds` JSON array contains the userId.
 * - Ledger entries with active "join" or "belong" verbs targeting the group.
 *
 * @param userId Agent UUID of the user.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Organization agents the user belongs to, ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const groups = await getGroupsForUser(userId, 20);
 * ```
 */
export async function getGroupsForUser(userId: string, limit = 50): Promise<Agent[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (a.id) a.*
    FROM agents a
    LEFT JOIN ledger l
      ON l.object_id = a.id
      AND l.object_type = 'agent'
      AND l.subject_id = ${userId}::uuid
      AND l.verb IN ('join', 'belong')
      AND l.is_active = true
    WHERE a.deleted_at IS NULL
      AND a.type = 'organization'
      AND (
        a.metadata->'memberIds' @> ${JSON.stringify([userId])}::jsonb
        OR a.metadata->>'creatorId' = ${userId}
        OR a.metadata->'adminIds' @> ${JSON.stringify([userId])}::jsonb
        OR l.id IS NOT NULL
      )
    ORDER BY a.id, a.created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Returns event-type agents where the given user is organizer, creator, or admin.
 *
 * @param userId Agent UUID of the user.
 * @param limit Max rows to return. Defaults to `50`.
 * @returns Event agents associated with the user, ordered newest first.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const events = await getEventsForUser(userId, 20);
 * ```
 */
export async function getEventsForUser(userId: string, limit = 50): Promise<Agent[]> {
  const result = await db.execute(sql`
    SELECT *
    FROM agents
    WHERE deleted_at IS NULL
      AND type = 'event'
      AND (
        metadata->>'organizerId' = ${userId}
        OR metadata->>'creatorId' = ${userId}
        OR metadata->'adminIds' @> ${JSON.stringify([userId])}::jsonb
      )
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result as Record<string, unknown>[]).map(rowToAgent);
}
