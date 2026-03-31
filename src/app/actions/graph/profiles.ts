"use server";

import { db } from "@/db";
import type { Agent, Resource } from "@/db/schema";
import { agents as agentsTable, resources as resourcesTable, ledger as ledgerTable } from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  toISOString,
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import {
  getAgent,
  getAgentFeed,
  getEventsForUser,
  getGroupsForUser,
} from "@/lib/queries/agents";
import {
  getResourcesByOwner,
  getResourcesByOwnerAndType,
} from "@/lib/queries/resources";
import {
  tryActorId,
  canViewAgent,
  filterViewableAgents,
  filterViewableResources,
  filterPubliclyCrawlableAgents,
  filterPubliclyCrawlableResources,
} from "./helpers";
import { isUuid } from "./types";

/**
 * Fetches profile data (agent + owned resources + recent activity) for a visible agent.
 *
 * @param agentId Profile owner agent id.
 * @returns Profile bundle, or `null` when inaccessible/missing.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const profile = await fetchProfileData(agentId);
 * ```
 */
export async function fetchProfileData(agentId: string) {
  const actorId = await tryActorId();
  if (actorId && !(await canViewAgent(actorId, agentId))) return null;

  const [agent, resources, feed] = await Promise.all([
    getAgent(agentId),
    getResourcesByOwner(agentId),
    getAgentFeed(agentId, 20),
  ]);

  if (!agent) return null;

  const objectIds = Array.from(
    new Set(
      feed
        .map((entry) => entry.objectId)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  );

  const [objectAgentsRaw, objectResourcesRaw] = objectIds.length > 0
    ? await Promise.all([
        db
          .select()
          .from(agentsTable)
          .where(and(inArray(agentsTable.id, objectIds), isNull(agentsTable.deletedAt))),
        db
          .select()
          .from(resourcesTable)
          .where(and(inArray(resourcesTable.id, objectIds), isNull(resourcesTable.deletedAt))),
      ])
    : [[], []];

  const visibleResources = actorId
    ? await filterViewableResources(actorId, resources)
    : resources;

  const visibleObjectAgents = actorId
    ? await filterViewableAgents(actorId, objectAgentsRaw)
    : await filterPubliclyCrawlableAgents(objectAgentsRaw);

  const visibleObjectResources = actorId
    ? await filterViewableResources(actorId, objectResourcesRaw)
    : await filterPubliclyCrawlableResources(objectResourcesRaw);

  const objectAgentMap = new Map(visibleObjectAgents.map((entry) => [entry.id, entry]));
  const objectResourceMap = new Map(visibleObjectResources.map((entry) => [entry.id, entry]));

  return {
    agent: serializeAgent(agent),
    resources: visibleResources.map(serializeResource),
    recentActivity: feed.map((entry) => ({
      id: entry.id,
      verb: entry.verb,
      subjectId: entry.subjectId,
      objectId: entry.objectId,
      metadata: entry.metadata as Record<string, unknown>,
      object:
        (entry.objectId && objectResourceMap.has(entry.objectId))
          ? (() => {
              const resource = objectResourceMap.get(entry.objectId)!;
              const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
              return {
                id: resource.id,
                name: resource.name,
                kind: "resource" as const,
                type: resource.type,
                image: null,
                metadata,
              };
            })()
          : (entry.objectId && objectAgentMap.has(entry.objectId))
            ? (() => {
                const targetAgent = objectAgentMap.get(entry.objectId)!;
                const metadata = (targetAgent.metadata ?? {}) as Record<string, unknown>;
                return {
                  id: targetAgent.id,
                  name: targetAgent.name,
                  kind: "agent" as const,
                  type: targetAgent.type,
                  image: targetAgent.image,
                  metadata,
                };
              })()
            : null,
      timestamp: toISOString(entry.timestamp),
    })),
  };
}

// ─── Targeted Profile Fetchers ──────────────────────────────────────────────
// These actions fetch ONLY the data a profile page needs for a specific user,
// eliminating the previous pattern of fetching 500-800 records and filtering
// client-side (Issue #61).

/**
 * Fetches posts created by a specific user.
 *
 * Queries resources where `ownerId` matches the user and type is "post" or "note",
 * plus resources where `metadata.entityType` is "post". Returns serialized
 * resources with owner agent data embedded so `resourceToPost` can produce
 * complete Post objects.
 *
 * @param userId Agent UUID of the user whose posts to fetch.
 * @param limit Max posts to return. Defaults to `30`.
 * @returns Serialized post resources with owner data.
 */
export async function fetchUserPosts(
  userId: string,
  limit = 30
): Promise<{ posts: SerializedResource[]; owner: SerializedAgent | null }> {
  if (!isUuid(userId)) return { posts: [], owner: null };

  const [postResources, noteResources, ownerAgent] = await Promise.all([
    getResourcesByOwnerAndType(userId, "post", limit),
    getResourcesByOwnerAndType(userId, "note", limit),
    getAgent(userId),
  ]);

  const combined = [...postResources, ...noteResources]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return {
    posts: combined.map(serializeResource),
    owner: ownerAgent ? serializeAgent(ownerAgent) : null,
  };
}

/**
 * Fetches events associated with a specific user (as organizer, creator, or admin).
 *
 * Queries both agent-type events and resource-type events owned by the user.
 * Returns serialized agents so existing `agentToEvent` adapter works unchanged.
 *
 * @param userId Agent UUID of the user.
 * @param limit Max events to return. Defaults to `30`.
 * @returns Serialized event agents.
 */
export async function fetchUserEvents(
  userId: string,
  limit = 30
): Promise<SerializedAgent[]> {
  if (!isUuid(userId)) return [];

  const [agentEvents, resourceEvents] = await Promise.all([
    getEventsForUser(userId, limit),
    getResourcesByOwnerAndType(userId, "event", limit),
  ]);

  // Convert resource-type events to serialized agent shapes for adapter compatibility
  const resourceEventAgents: SerializedAgent[] = resourceEvents.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      type: "event" as const,
      description: r.description,
      email: null,
      image: (meta.image as string) ?? null,
      metadata: {
        ...meta,
        startDate: meta.startDate ?? r.createdAt,
        endDate: meta.endDate ?? r.createdAt,
        organizerId: meta.organizerId ?? r.ownerId,
        creatorId: meta.creatorId ?? r.ownerId,
      },
      parentId: (meta.groupId as string) ?? null,
      pathIds: [],
      depth: 0,
      createdAt: toISOString(r.createdAt),
      updatedAt: toISOString(r.updatedAt),
    } as SerializedAgent;
  });

  // Deduplicate by id (prefer agent-type entry if both exist)
  const seen = new Set<string>();
  const deduped: SerializedAgent[] = [];
  for (const event of [...agentEvents.map(serializeAgent), ...resourceEventAgents]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    deduped.push(event);
  }

  return deduped.slice(0, limit);
}

/**
 * Fetches groups (organizations) that a specific user belongs to.
 *
 * Queries agent-type organizations where user is member/admin/creator,
 * plus resource-type groups owned by the user. Returns serialized agents
 * so existing `agentToGroup` adapter works unchanged.
 *
 * @param userId Agent UUID of the user.
 * @param limit Max groups to return. Defaults to `30`.
 * @returns Serialized group agents.
 */
export async function fetchUserGroups(
  userId: string,
  limit = 30
): Promise<SerializedAgent[]> {
  if (!isUuid(userId)) return [];

  const [agentGroups, resourceGroups] = await Promise.all([
    getGroupsForUser(userId, limit),
    getResourcesByOwnerAndType(userId, "group", limit),
  ]);

  // Filter out basins/locales from agent groups (they're not user groups)
  const filteredAgentGroups = agentGroups.filter((agent) => {
    const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
    return typeof metadata.placeType !== "string";
  });

  // Convert resource-type groups to serialized agent shapes
  const resourceGroupAgents: SerializedAgent[] = resourceGroups.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      type: "organization" as const,
      description: r.description,
      email: null,
      image: (meta.image as string) ?? null,
      metadata: {
        ...meta,
        creatorId: meta.creatorId ?? r.ownerId,
        memberIds: meta.memberIds ?? [r.ownerId],
      },
      parentId: null,
      pathIds: [],
      depth: 0,
      createdAt: toISOString(r.createdAt),
      updatedAt: toISOString(r.updatedAt),
    } as SerializedAgent;
  });

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped: SerializedAgent[] = [];
  for (const group of [...filteredAgentGroups.map(serializeAgent), ...resourceGroupAgents]) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    deduped.push(group);
  }

  return deduped.slice(0, limit);
}

// ─── Reaction Counts ────────────────────────────────────────────────────────

export type ReactionCountsMap = Record<string, number>;

/**
 * Counts reactions received on all resources owned by a user, grouped by
 * interactionType (like, love, laugh, wow, sad, angry).
 *
 * Queries ledger entries where verb='react', is_active=true, and
 * metadata->>'targetId' matches a resource owned by the given agent.
 *
 * @param agentId The resource owner whose received reactions to count.
 * @returns Map of interactionType to count, e.g. { like: 5, love: 2 }.
 */
export async function fetchReactionCountsForUser(
  agentId: string
): Promise<ReactionCountsMap> {
  if (!isUuid(agentId)) return {};

  const ownerResourceIds = db
    .select({ id: resourcesTable.id })
    .from(resourcesTable)
    .where(
      and(
        eq(resourcesTable.ownerId, agentId),
        isNull(resourcesTable.deletedAt)
      )
    );

  const rows = await db
    .select({
      interactionType: sql<string>`metadata->>'interactionType'`,
      count: sql<number>`count(*)::int`,
    })
    .from(ledgerTable)
    .where(
      and(
        eq(ledgerTable.verb, "react"),
        eq(ledgerTable.isActive, true),
        sql`metadata->>'targetId' IN (${ownerResourceIds})`
      )
    )
    .groupBy(sql`metadata->>'interactionType'`);

  const counts: ReactionCountsMap = {};
  for (const row of rows) {
    if (row.interactionType) {
      counts[row.interactionType] = row.count;
    }
  }
  return counts;
}

// ─── User Connections ───────────────────────────────────────────────────────

/**
 * Fetches the connections (people a user follows + people who follow them)
 * as serialized agent data suitable for the UserConnections component.
 *
 * Queries the ledger for active `follow` / `connect` interactions in both
 * directions (subject = user for following, objectId = user for followers),
 * then loads the corresponding agent records.
 *
 * @param userId Agent UUID of the user.
 * @returns Deduplicated list of connected agents.
 */
export async function fetchUserConnections(
  userId: string
): Promise<SerializedAgent[]> {
  if (!isUuid(userId)) return [];

  const actorId = await tryActorId();
  if (actorId && !(await canViewAgent(actorId, userId))) return [];

  // Get agent IDs the user follows
  const followingRows = await db.execute(sql`
    SELECT COALESCE(metadata->>'targetId', object_id::text) AS agent_id
    FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND verb = 'follow'
      AND is_active = true
      AND metadata->>'interactionType' = 'connect'
    ORDER BY timestamp DESC
    LIMIT 200
  `);

  // Get agent IDs that follow the user
  const followerRows = await db.execute(sql`
    SELECT subject_id::text AS agent_id
    FROM ledger
    WHERE (
      object_id = ${userId}::uuid
      OR metadata->>'targetId' = ${userId}::text
    )
      AND verb = 'follow'
      AND is_active = true
      AND metadata->>'interactionType' = 'connect'
    ORDER BY timestamp DESC
    LIMIT 200
  `);

  // Deduplicate all connection IDs
  const connectionIds = Array.from(
    new Set(
      [
        ...(followingRows as Array<Record<string, unknown>>),
        ...(followerRows as Array<Record<string, unknown>>),
      ]
        .map((row) => row.agent_id)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0 && value !== userId
        )
    )
  );

  if (connectionIds.length === 0) return [];

  // Load agent records for all connection IDs
  const connectedAgents = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        inArray(agentsTable.id, connectionIds),
        eq(agentsTable.type, "person"),
        isNull(agentsTable.deletedAt)
      )
    )
    .limit(200);

  const viewable = actorId
    ? await filterViewableAgents(actorId, connectedAgents)
    : connectedAgents;

  return viewable.map(serializeAgent);
}
