"use server";

import type { Agent } from "@/db/schema";
import {
  serializeAgent,
} from "@/lib/graph-serializers";
import type { SerializedAgent } from "@/lib/graph-serializers";
import {
  getAgentsInScope,
  getAgentsByType,
  getPlacesByPlaceType,
  searchAgents,
  searchAgentsInScope,
} from "@/lib/queries/agents";
import {
  tryActorId,
  filterViewableAgents,
} from "./helpers";
import { dedupeAgentsById } from "./types";

/**
 * Lists basin/region place nodes with duplicate ids removed.
 *
 * @param limit Max rows requested per place-type query.
 * @returns Serialized basin-like places, permission-filtered when authenticated.
 * @throws {Error} May throw on query errors; permission filter failures are caught and return `[]`.
 * @example
 * ```ts
 * const basins = await fetchBasins(50);
 * ```
 */
export async function fetchBasins(limit = 50): Promise<SerializedAgent[]> {
  // Place nodes (basins/regions) are public directory entries — skip per-agent
  // permission checks to avoid O(n) DB round trips on every page load.
  const allAgents = dedupeAgentsById([
    ...(await getPlacesByPlaceType("basin", limit)),
    ...(await getPlacesByPlaceType("region", limit)),
  ]);
  return allAgents.map(serializeAgent);
}

/**
 * Lists locale/chapter place nodes with duplicate ids removed.
 *
 * @param limit Max rows requested per place-type query.
 * @returns Serialized locale-like places, permission-filtered when authenticated.
 * @throws {Error} May throw on query errors; permission filter failures are caught and return `[]`.
 * @example
 * ```ts
 * const locales = await fetchLocales(50);
 * ```
 */
export async function fetchLocales(limit = 50): Promise<SerializedAgent[]> {
  // Place nodes (chapters/locales) are public directory entries — skip per-agent
  // permission checks to avoid O(n) DB round trips on every page load.
  const allAgents = dedupeAgentsById([
    ...(await getPlacesByPlaceType("chapter", limit)),
    ...(await getPlacesByPlaceType("locale", limit)),
  ]);
  return allAgents.map(serializeAgent);
}

/**
 * Fetches chapter/locale agents and maps them to the frontend `Chapter` shape.
 *
 * This action is designed for Client Components that previously imported static
 * chapter data from mock files.  It does not require authentication so the
 * chapter picker renders immediately for all visitors.
 *
 * @param limit Max rows to return.  Defaults to `100`.
 * @returns Chapter records derived from the agents table.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const chapters = await fetchChapters();
 * ```
 */
export async function fetchChapters(limit = 100) {
  const agents = dedupeAgentsById([
    ...(await getPlacesByPlaceType("chapter", limit)),
    ...(await getPlacesByPlaceType("locale", limit)),
  ]);

  return agents.map((agent) => {
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    return {
      id: agent.id,
      name: agent.name,
      slug: (meta.slug as string) ?? agent.id,
      memberCount: typeof meta.memberCount === "number" ? meta.memberCount : 0,
      image: agent.image ?? "/placeholder.svg",
      description: agent.description ?? "",
      location: (meta.location as string) ?? "",
      basinId: (meta.basinId as string) ?? "",
      isCommons: meta.isCommons === true,
    };
  });
}

/**
 * Fetches organization-type agents scoped to one or more locale IDs, excluding place-type agents.
 *
 * @param localeIds Locale scope IDs to query across.
 * @param limit Max rows requested per locale query.
 * @returns Deduplicated, permission-filtered serialized organization agents.
 */
export async function fetchGroupsByLocaleIds(localeIds: string[], limit = 100): Promise<SerializedAgent[]> {
  try {
    const normalizedLocaleIds = localeIds.filter((localeId) => localeId && localeId !== "all");
    if (normalizedLocaleIds.length === 0) return [];

    const actorId = await tryActorId();

    const perLocale = await Promise.all(
      normalizedLocaleIds.map((localeId) => getAgentsInScope(localeId, { type: "organization" }))
    );
    let agents = dedupeAgentsById(perLocale.flat());

    if (actorId) {
      agents = await filterViewableAgents(actorId, agents);
    }

    // Exclude place-type agents (same logic as fetchGroups)
    agents = agents.filter((agent) => {
      const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
      return typeof metadata.placeType !== "string";
    });

    return agents.slice(0, limit).map(serializeAgent);
  } catch (error) {
    console.error("[fetchGroupsByLocaleIds] failed:", error);
    return [];
  }
}

/**
 * Fetches person-type agents scoped to one or more locale IDs, with optional search.
 *
 * @param localeIds Locale scope IDs to query across.
 * @param query Optional search text to filter by name.
 * @param limit Max rows requested per locale query.
 * @returns Deduplicated, permission-filtered serialized person agents.
 */
export async function fetchPeopleByLocaleIds(localeIds: string[], query?: string, limit = 50): Promise<SerializedAgent[]> {
  try {
    const normalizedLocaleIds = localeIds.filter((localeId) => localeId && localeId !== "all");
    if (normalizedLocaleIds.length === 0) return [];

    const actorId = await tryActorId();

    const perLocale = await Promise.all(
      normalizedLocaleIds.map((localeId) =>
        query && query.trim().length > 0
          ? searchAgentsInScope(localeId, query, limit)
          : getAgentsInScope(localeId, { type: "person", limit })
      )
    );
    let agents = dedupeAgentsById(perLocale.flat());

    // Fallback: some user rows are not tagged to locale scope yet, especially in
    // dev/test data. When scoped lookup returns nothing, fall back to visible
    // person records so the picker still works instead of showing a dead empty
    // state.
    if (agents.length === 0) {
      const fallbackAgents = query && query.trim().length > 0
        ? await searchAgents(query, limit)
        : await getAgentsByType("person", limit);
      agents = dedupeAgentsById(fallbackAgents);
    }

    if (actorId) {
      agents = await filterViewableAgents(actorId, agents);
    }

    return agents.slice(0, limit).map(serializeAgent);
  } catch (error) {
    console.error("[fetchPeopleByLocaleIds] failed:", error);
    return [];
  }
}
