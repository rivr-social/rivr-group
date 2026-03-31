"use server";

import type { Agent, Resource } from "@/db/schema";
import {
  toISOString,
  toJsonSafe,
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import type { SerializedAgent } from "@/lib/graph-serializers";
import { q } from "@/lib/graph-query";
import {
  getAgent,
  getAgentsByType,
  getAgentsInScope,
  getPlacesByPlaceType,
  searchAgents,
} from "@/lib/queries/agents";
import {
  getMarketplaceListings as queryMarketplaceListings,
  getResourcesByType,
} from "@/lib/queries/resources";
import {
  requireActorId,
  tryActorId,
  filterViewableAgents,
} from "./helpers";

/**
 * Builds the mixed home feed from agents and resource-backed entities.
 *
 * Error handling pattern:
 * - Each subquery is isolated through `safeQuery` so one failing source does not break the feed.
 *
 * Auth and rate limiting:
 * - Auth is optional (`tryActorId`); authenticated users are permission-filtered.
 * - No local rate limit is enforced; caller-side throttling is expected.
 *
 * @param limit Max rows requested per feed source.
 * @returns Home feed buckets (`people`, `groups`, `events`, `places`, `projects`, `marketplace`).
 * @throws {Error} May throw when non-isolated parts (for example permission checks) fail.
 * @example
 * ```ts
 * const home = await fetchHomeFeed(20);
 * ```
 */
export async function fetchHomeFeed(limit = 20) {
  const actorId = await tryActorId();

  // Helper: run a query with error isolation so one failure doesn't kill the whole feed
  async function safeQuery<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[fetchHomeFeed] query "${label}" failed:`, String(err));
      return fallback;
    }
  }

  // Fetch from agents table (non-event types) and resources table.
  // Events are resources only — never agents.
  // Also fetch the actor's agent record (if authenticated) for scope-based visibility.
  const [
    people, groups, placesLegacy, projects,
    placeChapters, placeBasins, placeCouncils,
    resourceGroups, resourceEvents, resourceProjects, resourceListings,
    actorAgent,
  ] = await Promise.all([
    safeQuery("people", () => getAgentsByType("person", limit), []),
    safeQuery("groups", () => getAgentsByType("organization", limit), []),
    safeQuery("placesLegacy", () => getAgentsByType("place", limit), []),
    safeQuery("projects", () => getAgentsByType("project", limit), []),
    safeQuery("placeChapters", () => getPlacesByPlaceType("chapter", limit), []),
    safeQuery("placeBasins", () => getPlacesByPlaceType("basin", limit), []),
    safeQuery("placeCouncils", () => getPlacesByPlaceType("council", limit), []),
    safeQuery("resourceGroups", () => getResourcesByType("group", limit), []),
    safeQuery("resourceEvents", () => getResourcesByType("event", limit), []),
    safeQuery("resourceProjects", () => getResourcesByType("project", limit), []),
    safeQuery("resourceListings", () => queryMarketplaceListings(limit), []),
    safeQuery("actorAgent", () => actorId ? getAgent(actorId) : Promise.resolve(null), null),
  ]);

  const places = [...placesLegacy, ...placeChapters, ...placeBasins, ...placeCouncils];
  // Home feed shows public discovery content. Agents from getAgentsByType are already
  // non-deleted public entities. Skip per-item permission checks (which were N+1 DB calls)
  // to avoid 170+ unnecessary queries on every authenticated page load.
  // Visibility is enforced at detail-page level when users click into specific items.
  const visiblePeople = people;
  const visibleGroups = (groups as Agent[]).filter((agent) => {
    const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
    return typeof metadata.placeType !== "string";
  });
  const visiblePlaces = places;
  const visibleProjects = projects;

  // Resource visibility: public items are visible to everyone. For authenticated users,
  // also include resources they own or that are scoped to their locales/groups/user ID.
  // This avoids N+1 permission queries — scope data is already on the resource objects.
  const actorPathIds = new Set<string>(
    actorAgent && Array.isArray(actorAgent.pathIds) ? actorAgent.pathIds : []
  );

  function isVisibleResource(r: Resource): boolean {
    if (r.isPublic !== false) return true;
    if (!actorId) return false;
    // Creators always see their own resources.
    if (r.ownerId === actorId) return true;
    // Check scope-based visibility from resource metadata.
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const scopedUserIds = Array.isArray(meta.scopedUserIds) ? meta.scopedUserIds as string[] : [];
    if (scopedUserIds.includes(actorId)) return true;
    // Check locale/group scope overlap with actor's locale/group memberships.
    const scopedLocaleIds = Array.isArray(meta.scopedLocaleIds) ? meta.scopedLocaleIds as string[] : [];
    const scopedGroupIds = Array.isArray(meta.scopedGroupIds) ? meta.scopedGroupIds as string[] : [];
    const allScopes = [...scopedLocaleIds, ...scopedGroupIds];
    if (allScopes.length > 0 && allScopes.some((id) => actorPathIds.has(id))) return true;
    return false;
  }

  const visibleResourceGroups = (resourceGroups as Resource[]).filter(isVisibleResource);
  const visibleResourceEvents = (resourceEvents as Resource[]).filter(isVisibleResource);
  const visibleResourceProjects = (resourceProjects as Resource[]).filter(isVisibleResource);

  // Convert resource-based groups/events/projects to serialized agent shapes
  // so the existing adapters (agentToGroup, agentToEvent, etc.) can handle them
  const scopeTagsFromResource = (resource: Resource): string[] => {
    const meta = ((resource.metadata ?? {}) as Record<string, unknown>);
    const chapterTags = Array.isArray(meta.chapterTags) ? (meta.chapterTags as string[]) : [];
    const owner = (resource as Resource & { owner?: Agent | null }).owner ?? null;
    const ownerPathIds = Array.isArray(owner?.pathIds) ? owner.pathIds : [];
    const ownerChapterTags =
      owner && owner.metadata && Array.isArray((owner.metadata as Record<string, unknown>).chapterTags)
        ? ((owner.metadata as Record<string, unknown>).chapterTags as string[])
        : [];
    return Array.from(new Set([...chapterTags, ...ownerChapterTags, ...ownerPathIds]));
  };

  const agentIdSet = new Set(visibleGroups.map((a) => a.id));
  const resourceGroupAgents: SerializedAgent[] = visibleResourceGroups
    // Prevent duplicate cards when both agent and resource representations exist for same id.
    .filter((r) => !agentIdSet.has(r.id))
    .map((r) => {
      const scopeTags = scopeTagsFromResource(r as Resource);
      return {
        id: r.id,
        name: r.name,
        type: "organization" as const,
        description: r.description,
        email: null,
        image: null,
        metadata: {
          ...(toJsonSafe((r.metadata as Record<string, unknown>) ?? {}) as Record<string, unknown>),
          creatorId: r.ownerId,
          tags: r.tags ?? [],
          chapterTags: scopeTags,
        },
        parentId: ((r.metadata as Record<string, unknown>)?.parentGroupId as string) ?? null,
        pathIds: scopeTags,
        depth: 0,
        createdAt: toISOString(r.createdAt),
        updatedAt: toISOString(r.updatedAt),
      };
    });

  // Events are resources only — convert to serialized agent shape for adapter compatibility
  const resourceEventAgents: SerializedAgent[] = visibleResourceEvents
    .map((r) => {
      const meta = (toJsonSafe(r.metadata ?? {}) as Record<string, unknown>);
      const scopeTags = scopeTagsFromResource(r as Resource);
      return {
        id: r.id,
        name: r.name,
        type: "event" as const,
        description: r.description,
        email: null,
        image: null,
        metadata: {
          ...meta,
          startDate: (meta.date as string) ?? toISOString(r.createdAt),
          endDate: (meta.date as string) ?? toISOString(r.createdAt),
          creatorId: r.ownerId,
          tags: r.tags ?? [],
          chapterTags: scopeTags,
        },
        parentId: (meta.groupId as string) ?? null,
        pathIds: scopeTags,
        depth: 0,
        createdAt: toISOString(r.createdAt),
        updatedAt: toISOString(r.updatedAt),
      };
    });

  const projectIdSet = new Set(visibleProjects.map((a) => a.id));
  const resourceProjectAgents: SerializedAgent[] = visibleResourceProjects
    .filter((r) => !projectIdSet.has(r.id))
    .map((r) => {
      const meta = (toJsonSafe(r.metadata ?? {}) as Record<string, unknown>);
      const scopeTags = scopeTagsFromResource(r as Resource);
      return {
        id: r.id,
        name: r.name,
        type: "project" as const,
        description: r.description,
        email: null,
        image: null,
        metadata: {
          ...meta,
          creatorId: r.ownerId,
          status: "active",
          tags: r.tags ?? [],
          chapterTags: scopeTags,
        },
        parentId: (meta.groupId as string) ?? null,
        pathIds: scopeTags,
        depth: 0,
        createdAt: toISOString(r.createdAt),
        updatedAt: toISOString(r.updatedAt),
      };
    });

  // Build marketplace from resource listings
  const marketplaceItems = resourceListings.map((item) => ({
    ...serializeResource(item as unknown as Resource),
    ownerName: (item as { owner_name?: string }).owner_name ?? "",
    ownerImage: (item as { owner_image?: string }).owner_image ?? "",
  }));

  return {
    people: visiblePeople.map(serializeAgent),
    groups: [...visibleGroups.map(serializeAgent), ...resourceGroupAgents],
    events: resourceEventAgents,
    places: visiblePlaces.map(serializeAgent),
    projects: [...visibleProjects.map(serializeAgent), ...resourceProjectAgents],
    marketplace: marketplaceItems,
  };
}

/**
 * Returns explore-feed results; with query it performs search, otherwise category sampling.
 *
 * @param query Optional query text for direct search mode.
 * @param limit Max rows requested for search/category queries.
 * @returns Object containing a single `results` array of serialized agents.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const explore = await fetchExploreFeed("mutual aid", 30);
 * ```
 */
export async function fetchExploreFeed(query?: string, limit = 20) {
  const actorId = await requireActorId();

  if (query && query.trim().length > 0) {
    const results = await searchAgents(query, limit);
    const visible = await filterViewableAgents(actorId, results);
    return { results: visible.map(serializeAgent) };
  }

  const [people, groups, events] = await Promise.all([
    getAgentsByType("person", limit),
    getAgentsByType("organization", limit),
    getAgentsByType("event", limit),
  ]);

  const [visiblePeople, visibleGroups, visibleEvents] = await Promise.all([
    filterViewableAgents(actorId, people),
    filterViewableAgents(actorId, groups),
    filterViewableAgents(actorId, events),
  ]);

  return {
    results: [
      ...visiblePeople.map(serializeAgent),
      ...visibleGroups.map(serializeAgent),
      ...visibleEvents.map(serializeAgent),
    ],
  };
}

/**
 * Loads activity feed entries for an agent when the actor may view that agent.
 *
 * @param agentId Agent id whose feed should be returned.
 * @param limit Max feed entries.
 * @returns Serialized ledger-style feed entries, or `[]` when not authorized.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const feed = await fetchAgentFeed(agentId, 25);
 * ```
 */
export async function fetchAgentFeed(agentId: string, limit = 50) {
  const entries = await q<unknown[]>("required", { table: "ledger", fn: "getAgentFeed", agentId, limit }, {
    permissions: "skip",
    serialize: "raw",
    requireViewable: agentId,
  });
  if (!entries) return [];
  return (entries as { id: string; verb: string; subjectId: string; objectId: string; objectType: string; metadata: unknown; timestamp: unknown }[]).map((entry) => ({
    id: entry.id,
    verb: entry.verb,
    subjectId: entry.subjectId,
    objectId: entry.objectId,
    objectType: entry.objectType,
    metadata: entry.metadata as Record<string, unknown>,
    timestamp: toISOString(entry.timestamp),
  }));
}

/**
 * Returns home-feed buckets constrained to a specific scope agent.
 *
 * @param scopeId Scope agent id (for example chapter/group id).
 * @param limit Max rows requested per category query.
 * @returns Scoped people/groups/events/places/projects buckets.
 * @throws {Error} May throw on query/permission-check failures.
 * @example
 * ```ts
 * const scoped = await fetchScopedHomeFeed(scopeId, 20);
 * ```
 */
export async function fetchScopedHomeFeed(scopeId: string, limit = 20) {
  const actorId = await tryActorId();

  const [people, groups, events, placesLegacy, placesChapter, placesBasin, placesCouncil, projects] = await Promise.all([
    getAgentsInScope(scopeId, { type: "person", limit }),
    getAgentsInScope(scopeId, { type: "organization", limit }),
    getAgentsInScope(scopeId, { type: "event", limit }),
    getAgentsInScope(scopeId, { type: "place", limit }),
    getPlacesByPlaceType("chapter", limit),
    getPlacesByPlaceType("basin", limit),
    getPlacesByPlaceType("council", limit),
    getAgentsInScope(scopeId, { type: "project", limit }),
  ]);

  // Place records come from mixed queries; keep only nodes that belong to the requested scope.
  const placesInScope = [...placesLegacy, ...placesChapter, ...placesBasin, ...placesCouncil]
    .filter((a) => a.parentId === scopeId || (a.pathIds ?? []).includes(scopeId));

  const [visiblePeople, visibleGroups, visibleEvents, visiblePlaces, visibleProjects] = actorId
    ? await Promise.all([
        filterViewableAgents(actorId, people),
        filterViewableAgents(actorId, groups),
        filterViewableAgents(actorId, events),
        filterViewableAgents(actorId, placesInScope),
        filterViewableAgents(actorId, projects),
      ])
    : [people, groups, events, placesInScope, projects];

  // Exclude place-type agents from groups (same filter as fetchHomeFeed)
  const filteredGroups = (visibleGroups as Agent[]).filter((agent) => {
    const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
    return typeof metadata.placeType !== "string";
  });

  return {
    people: visiblePeople.map(serializeAgent),
    groups: filteredGroups.map(serializeAgent),
    events: visibleEvents.map(serializeAgent),
    places: visiblePlaces.map(serializeAgent),
    projects: visibleProjects.map(serializeAgent),
  };
}
