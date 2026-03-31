"use server";

import type { Agent, AgentType } from "@/db/schema";
import { q } from "@/lib/graph-query";
import type { SerializedAgent } from "@/lib/graph-serializers";

/**
 * Fetches a single agent by id if the current actor is authenticated and authorized to view it.
 *
 * @param id Agent id to retrieve.
 * @returns Serialized agent payload, or `null` when missing/inaccessible.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const agent = await fetchAgent("9c8f...uuid");
 * ```
 */
export async function fetchAgent(id: string): Promise<SerializedAgent | null> {
  return q("required", { table: "agents", fn: "getAgent", id });
}

/**
 * Fetches a single agent by id using the optional/public visibility path.
 *
 * Use this for public profile and public detail surfaces that may resolve a
 * person by UUID fallback when no username is available.
 */
export async function fetchPublicAgentById(id: string): Promise<SerializedAgent | null> {
  return q("optional", { table: "agents", fn: "getAgent", id });
}

/**
 * Fetches a single agent by username when the caller can view that agent.
 *
 * @param username Unique username associated with an agent.
 * @returns Serialized agent payload, or `null` when not found or not viewable.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const profile = await fetchAgentByUsername("alex");
 * ```
 */
export async function fetchAgentByUsername(username: string): Promise<SerializedAgent | null> {
  return q("optional", { table: "agents", fn: "getAgentByUsername", username });
}

/**
 * Lists person-type agents visible to the current authenticated actor.
 *
 * @param limit Max rows requested from the backing query.
 * @returns Serialized person agents allowed by policy checks.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const people = await fetchPeople(25);
 * ```
 */
export async function fetchPeople(limit = 50): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentsByType", type: "person", limit });
}

/**
 * Lists group-like organizations, excluding place hierarchy nodes.
 *
 * Auth/rate-limit/error pattern:
 * - Public callers can receive unfiltered candidates.
 * - Authenticated callers are permission-filtered.
 * - Permission-filter failures are caught and logged, returning `[]`.
 *
 * @param limit Max rows requested from the backing query.
 * @returns Serialized organizations that represent groups.
 * @throws {Error} May rethrow unexpected database/query errors before fallback handling.
 * @example
 * ```ts
 * const groups = await fetchGroups();
 * ```
 */
export async function fetchGroups(limit = 50): Promise<SerializedAgent[]> {
  try {
    return await q("optional", { table: "agents", fn: "getAgentsByType", type: "organization", limit }, {
      postFilter: (items) => (items as Agent[]).filter((agent) => {
        const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
        return typeof metadata.placeType !== "string";
      }),
    });
  } catch (error) {
    console.error("[fetchGroups] permission filter failed:", error);
    return [];
  }
}

/**
 * Fetches direct children of an agent after confirming parent visibility.
 *
 * @param parentId Parent agent id.
 * @returns Serialized child agents, or `[]` when the parent is not viewable.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const children = await fetchAgentChildren(groupId);
 * ```
 */
export async function fetchAgentChildren(parentId: string): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentChildren", parentId }, { requireViewable: parentId });
}

/**
 * Searches agents by name and returns only entities visible to the caller.
 *
 * @param query Search text sent to the underlying name query.
 * @param limit Max results requested.
 * @returns Serialized matching agents after permission filtering.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const matches = await searchAgentsByName("river", 10);
 * ```
 */
export async function searchAgentsByName(query: string, limit = 20): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "searchAgents", query, limit });
}

/**
 * Searches agents by type and optional name query.
 * Used for targeting specific agent instances in offering creation.
 */
export async function searchAgentsByType(
  type: string,
  query?: string,
  limit = 30
): Promise<SerializedAgent[]> {
  const agents: SerializedAgent[] = await q("required", {
    table: "agents",
    fn: "getAgentsByType",
    type,
    limit: query ? 200 : limit,
  });
  if (!query) return agents.slice(0, limit);
  const lowerQuery = query.toLowerCase();
  return agents.filter((a) => a.name.toLowerCase().includes(lowerQuery)).slice(0, limit);
}

/**
 * Finds nearby agents and filters by actor visibility.
 *
 * @param lat Latitude in decimal degrees.
 * @param lng Longitude in decimal degrees.
 * @param radiusMeters Search radius in meters.
 * @returns Serialized nearby agents visible to the authenticated actor.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const nearby = await fetchAgentsNearby(45.52, -122.67, 10000);
 * ```
 */
export async function fetchAgentsNearby(
  lat: number,
  lng: number,
  radiusMeters = 5000
): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentsNearby", lat, lng, radiusMeters });
}

/**
 * Retrieves agents with optional paging/type filters and applies policy-based visibility.
 *
 * @param options Optional type and pagination options.
 * @returns Serialized agents that pass authorization checks.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const page = await fetchAllAgents({ type: "person", limit: 50, offset: 0 });
 * ```
 */
export async function fetchAllAgents(options?: {
  type?: AgentType;
  limit?: number;
  offset?: number;
}): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAllAgents", options });
}

/**
 * Fetches agents by id list and filters out unauthorized rows.
 *
 * @param ids Agent ids to load.
 * @returns Serialized agents visible to the authenticated actor.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const nodes = await fetchAgentsByIds(["uuid-1", "uuid-2"]);
 * ```
 */
export async function fetchAgentsByIds(ids: string[]): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentsByIds", ids });
}
