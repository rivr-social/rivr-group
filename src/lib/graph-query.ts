/**
 * Datalog-inspired declarative graph query layer.
 *
 * Provides three primitives that compose existing query functions from
 * `agents.ts` and `resources.ts` with automatic auth resolution,
 * permission filtering, and serialization:
 *
 * - `q(auth, pattern, opts?)` — single-table query
 * - `multi(auth, queries, opts?)` — parallel composition
 *
 * No new Drizzle queries are written here. This module is strictly an
 * orchestration layer over existing query functions.
 */

import { auth } from "@/auth";
import type { Agent, Resource } from "@/db/schema";
import { check } from "@/lib/permissions";
import {
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import {
  getAgent,
  getAgentByUsername,
  getAgentChildren,
  getAgentFeed,
  getAgentsByIds,
  getAgentsByType,
  getGroupMembers,
  getAgentsInScope,
  getAgentsNearby,
  getAllAgents,
  getPlacesByPlaceType,
  searchAgents,
  searchAgentsInScope,
} from "@/lib/queries/agents";
import {
  getAllResources,
  getPublicResources,
  getResource,
  getResourcesForGroup,
  getResourcesByOwner,
  getResourcesByType,
} from "@/lib/queries/resources";

// ─── Auth Types ──────────────────────────────────────────────────────────────

/** "required" throws if no session; "optional" falls back to null */
export type AuthMode = "required" | "optional";

// ─── Pattern Types ───────────────────────────────────────────────────────────

// Each pattern variant maps to an existing query function and its arguments.
// The discriminant `fn` selects which function to call via PATTERN_DISPATCH.

export type AgentPattern =
  | { table: "agents"; fn: "getAgent"; id: string }
  | { table: "agents"; fn: "getAgentByUsername"; username: string }
  | { table: "agents"; fn: "getAgentsByType"; type: string; limit?: number }
  | { table: "agents"; fn: "getAgentChildren"; parentId: string }
  | { table: "agents"; fn: "getAgentsByIds"; ids: string[] }
  | { table: "agents"; fn: "getAllAgents"; options?: { type?: string; limit?: number; offset?: number } }
  | { table: "agents"; fn: "searchAgents"; query: string; limit?: number }
  | { table: "agents"; fn: "getAgentsNearby"; lat: number; lng: number; radiusMeters?: number }
  | { table: "agents"; fn: "getGroupMembers"; groupId: string }
  | { table: "agents"; fn: "getAgentsInScope"; scopeId: string; options?: { type?: string; limit?: number; offset?: number } }
  | { table: "agents"; fn: "searchAgentsInScope"; scopeId: string; query: string; limit?: number }
  | { table: "agents"; fn: "getPlacesByPlaceType"; placeType: string; limit?: number };

export type ResourcePattern =
  | { table: "resources"; fn: "getResource"; id: string }
  | { table: "resources"; fn: "getResourcesByOwner"; ownerId: string }
  | { table: "resources"; fn: "getPublicResources"; limit?: number }
  | { table: "resources"; fn: "getResourcesByType"; type: string; limit?: number }
  | { table: "resources"; fn: "getResourcesForGroup"; groupId: string; limit?: number }
  | { table: "resources"; fn: "getAllResources"; options?: { type?: string; limit?: number; offset?: number } };

export type LedgerPattern =
  | { table: "ledger"; fn: "getAgentFeed"; agentId: string; limit?: number };

export type Pattern = AgentPattern | ResourcePattern | LedgerPattern;

// ─── Query Options ───────────────────────────────────────────────────────────

export interface QueryOptions {
  /** Whether to permission-filter results. Default: "filter" */
  permissions?: "filter" | "skip";
  /** Whether to serialize results. Default: "serialize" */
  serialize?: "serialize" | "raw";
  /** Custom post-processor applied after permission filtering, before serialization */
  postFilter?: (items: unknown[]) => unknown[];
  /** Custom serializer override (e.g. agentToMemberInfo) */
  customSerializer?: (item: unknown) => unknown;
  /** Require visibility of a specific agent before running query */
  requireViewable?: string;
}

export interface MultiOptions {
  /** If true (default), catches individual sub-query errors and returns fallback */
  isolateFailures?: boolean;
}

// ─── Auth Resolution ─────────────────────────────────────────────────────────

async function resolveAuth(mode: AuthMode): Promise<string | null> {
  if (mode === "required") {
    const session = await auth();
    const actorId = session?.user?.id;
    if (!actorId) throw new Error("Unauthorized");
    return actorId;
  }
  try {
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Permission Helpers ──────────────────────────────────────────────────────

async function canViewAgent(actorId: string, agentId: string): Promise<boolean> {
  const result = await check(actorId, "view", agentId, "agent");
  return result.allowed;
}

async function canViewResource(actorId: string, resourceId: string): Promise<boolean> {
  const result = await check(actorId, "view", resourceId, "resource");
  return result.allowed;
}

/**
 * Batch-filter viewable agents. Public and locale-visible agents are allowed
 * client-side without per-item permission checks to avoid O(N) DB queries.
 * Only non-public/non-locale items go through the full permission check.
 */
async function filterViewableAgents(actorId: string, agents: Agent[]): Promise<Agent[]> {
  const publicOrLocale: Agent[] = [];
  const needsCheck: Agent[] = [];

  for (const a of agents) {
    const vis = (a as { visibility?: string }).visibility;
    if (vis === "public" || vis === "locale") {
      publicOrLocale.push(a);
    } else {
      needsCheck.push(a);
    }
  }

  const checkedPermissions = await Promise.all(
    needsCheck.map((a) => canViewAgent(actorId, a.id))
  );
  const allowed = needsCheck.filter((_, i) => checkedPermissions[i]);

  return [...publicOrLocale, ...allowed];
}

/**
 * Batch-filter viewable resources. Public and locale-visible resources are allowed
 * client-side without per-item permission checks to avoid O(N) DB queries.
 * Only non-public/non-locale items go through the full permission check.
 */
async function filterViewableResources(actorId: string, resources: Resource[]): Promise<Resource[]> {
  const publicOrLocale: Resource[] = [];
  const needsCheck: Resource[] = [];

  for (const r of resources) {
    const vis = (r as { visibility?: string }).visibility;
    if (vis === "public" || vis === "locale") {
      publicOrLocale.push(r);
    } else {
      needsCheck.push(r);
    }
  }

  const checkedPermissions = await Promise.all(
    needsCheck.map((r) => canViewResource(actorId, r.id))
  );
  const allowed = needsCheck.filter((_, i) => checkedPermissions[i]);

  return [...publicOrLocale, ...allowed];
}

// ─── Pattern Dispatch ────────────────────────────────────────────────────────

/**
 * Execute a pattern by dispatching to the correct query function.
 * Returns the raw query result (unfiltered, unserialized).
 */
async function executePattern(pattern: Pattern): Promise<unknown> {
  switch (pattern.fn) {
    // ── Agent queries ──
    case "getAgent":
      return getAgent(pattern.id);
    case "getAgentByUsername":
      return getAgentByUsername(pattern.username);
    case "getAgentsByType":
      return getAgentsByType(pattern.type as Parameters<typeof getAgentsByType>[0], pattern.limit);
    case "getAgentChildren":
      return getAgentChildren(pattern.parentId);
    case "getAgentsByIds":
      return getAgentsByIds(pattern.ids);
    case "getAllAgents":
      return getAllAgents(pattern.options as Parameters<typeof getAllAgents>[0]);
    case "searchAgents":
      return searchAgents(pattern.query, pattern.limit);
    case "getAgentsNearby":
      return getAgentsNearby(pattern.lat, pattern.lng, pattern.radiusMeters);
    case "getGroupMembers":
      return getGroupMembers(pattern.groupId);
    case "getAgentsInScope":
      return getAgentsInScope(pattern.scopeId, pattern.options as Parameters<typeof getAgentsInScope>[1]);
    case "searchAgentsInScope":
      return searchAgentsInScope(pattern.scopeId, pattern.query, pattern.limit);
    case "getPlacesByPlaceType":
      return getPlacesByPlaceType(pattern.placeType, pattern.limit);

    // ── Resource queries ──
    case "getResource":
      return getResource(pattern.id);
    case "getResourcesByOwner":
      return getResourcesByOwner(pattern.ownerId);
    case "getPublicResources":
      return getPublicResources(pattern.limit);
    case "getResourcesByType":
      return getResourcesByType(pattern.type as Parameters<typeof getResourcesByType>[0], pattern.limit);
    case "getResourcesForGroup":
      return getResourcesForGroup(pattern.groupId, pattern.limit);
    case "getAllResources":
      return getAllResources(pattern.options as Parameters<typeof getAllResources>[0]);

    // ── Ledger queries ──
    case "getAgentFeed":
      return getAgentFeed(pattern.agentId, pattern.limit);

    default: {
      const _exhaustive: never = pattern;
      throw new Error(`Unknown pattern: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ─── Core: q() ───────────────────────────────────────────────────────────────

/**
 * Single-table query with automatic auth, permission filtering, and serialization.
 *
 * @param mode - "required" throws if unauthenticated; "optional" allows anonymous
 * @param pattern - Describes which query function to call and with what args
 * @param opts - Control permission filtering, serialization, custom mappers
 * @returns Serialized result(s) matching the pattern
 */
export async function q<T = unknown>(
  mode: AuthMode,
  pattern: Pattern,
  opts?: QueryOptions,
): Promise<T> {
  const actorId = await resolveAuth(mode);
  const {
    permissions = "filter",
    serialize = "serialize",
    postFilter,
    customSerializer,
    requireViewable,
  } = opts ?? {};

  // Pre-check: verify actor can view a specific entity before running the main query
  if (requireViewable && actorId) {
    const canView = await canViewAgent(actorId, requireViewable);
    if (!canView) return (pattern.table === "agents" ? [] : []) as T;
  }

  const raw = await executePattern(pattern);

  // Null/undefined results for single-entity queries
  if (raw === null || raw === undefined) {
    return null as T;
  }

  const isSingle = !Array.isArray(raw);
  const items = isSingle ? [raw] : (raw as unknown[]);

  // Permission filtering
  let filtered = items;
  if (permissions === "filter" && actorId) {
    if (pattern.table === "agents") {
      if (isSingle) {
        const agent = items[0] as Agent;
        const allowed = await canViewAgent(actorId, agent.id);
        filtered = allowed ? [agent] : [];
      } else {
        filtered = await filterViewableAgents(actorId, items as Agent[]);
      }
    } else if (pattern.table === "resources") {
      if (isSingle) {
        const resource = items[0] as Resource;
        const allowed = await canViewResource(actorId, resource.id);
        filtered = allowed ? [resource] : [];
      } else {
        filtered = await filterViewableResources(actorId, items as Resource[]);
      }
    }
    // Ledger patterns skip permission filtering (handled by caller)
  }

  // Post-filter hook
  if (postFilter) {
    filtered = postFilter(filtered);
  }

  // Serialization
  let result: unknown[];
  if (serialize === "raw") {
    result = filtered;
  } else if (customSerializer) {
    result = filtered.map(customSerializer);
  } else if (pattern.table === "agents") {
    result = filtered.map((item) => serializeAgent(item as Agent));
  } else if (pattern.table === "resources") {
    result = filtered.map((item) => serializeResource(item as Resource));
  } else {
    // Ledger entries — no built-in serializer, return as-is
    result = filtered;
  }

  // Return single or array to match query type
  if (isSingle) {
    return (result.length > 0 ? result[0] : null) as T;
  }
  return result as T;
}

// ─── Core: multi() ───────────────────────────────────────────────────────────

/** A named sub-query for multi() composition */
export interface SubQuery<T = unknown> {
  key: string;
  fn: () => Promise<T>;
  fallback: T;
}

/**
 * Parallel composition of multiple queries with isolated failure handling.
 *
 * @param queries - Named sub-queries to execute in parallel
 * @param opts - Control failure isolation
 * @returns Object keyed by query names with their results
 */
export async function multi<T extends Record<string, unknown>>(
  queries: SubQuery[],
  opts?: MultiOptions,
): Promise<T> {
  const { isolateFailures = true } = opts ?? {};

  const results = await Promise.all(
    queries.map(async (sub) => {
      if (isolateFailures) {
        try {
          return { key: sub.key, value: await sub.fn() };
        } catch (err) {
          console.error(`[multi] query "${sub.key}" failed:`, String(err));
          return { key: sub.key, value: sub.fallback };
        }
      }
      return { key: sub.key, value: await sub.fn() };
    }),
  );

  const out: Record<string, unknown> = {};
  for (const { key, value } of results) {
    out[key] = value;
  }
  return out as T;
}
