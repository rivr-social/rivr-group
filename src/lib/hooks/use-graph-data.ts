"use client";

/**
 * Client-side semantic graph data hooks.
 *
 * This module exposes React hooks for reading graph-backed entities from server
 * actions and adapting them into UI-facing models with cache + sync behavior.
 *
 * Key exports:
 * - Entity hooks: `usePeople`, `useGroups`, `useEvents`, `usePlaces`, `usePosts`
 * - Feed/search hooks: `useHomeFeed`, `useAgentSearch`, `useAgent`
 * - Marketplace/location hooks: `useMarketplace`, `useLocalesAndBasins`
 * - Cache utility: `invalidateGraphCache`
 *
 * Dependencies:
 * - `@/app/actions/graph` server actions for data access.
 * - `@/lib/graph-adapters` for API-to-UI object mapping.
 * - React hooks/state primitives.
 */

import { useState, useEffect, useRef, startTransition } from "react";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import {
  fetchPeople,
  fetchGroups,
  fetchEvents,
  fetchPlaces,
  fetchPublicResources,
  fetchHomeFeed,
  fetchScopedHomeFeed,
  fetchBasins,
  fetchLocales,
  fetchAgent,
  fetchMarketplaceListings,
  searchAgentsByName,
} from "@/app/actions/graph";
import {
  agentToUser,
  agentToGroup,
  agentToEvent,
  agentToPlace,
  agentToProject,
  agentToBasin,
  agentToLocale,
  resourceToMarketplaceListing,
  resourceToPost,
} from "@/lib/graph-adapters";
import type { User, Group, MarketplaceListing, Basin, Chapter, Post } from "@/lib/types";
import {
  localDb,
  isStale,
  markSynced,
  upsertAgents,
  upsertResources,
  getLocalAgentsByType,
  getLocalResourcesByType,
  searchLocalAgents,
  getLocalAgent,
  type LocalAgent,
  type LocalResource,
} from "@/lib/local-db";

// Inferred return types from graph adapter functions
type GraphEvent = ReturnType<typeof agentToEvent>;
type GraphPlace = ReturnType<typeof agentToPlace>;
type GraphProject = ReturnType<typeof agentToProject>;

/** Canonical async loading state used by graph hooks. */
type LoadState = "idle" | "loading" | "loaded" | "error";
/** Cache record persisted in `sessionStorage`, versioned for migration safety. */
type CacheEntry<T> = { v: number; ts: number; data: T };
/** Cross-tab sync payload for cache write/invalidation notifications. */
type GraphSyncMessage = { type: "cache-write" | "invalidate"; key: string; ts: number };

/** Session cache schema version; bumping invalidates stale payload shapes. */
const GRAPH_CACHE_VERSION = 1;
/** Default cache TTL for list views. */
const DEFAULT_TTL_MS = 1000 * 60 * 5;
/** Foreground refresh cadence for live-ish data. Relaxed in dev to reduce CPU churn. */
const ACTIVE_REFRESH_MS = process.env.NODE_ENV === "development" ? 1000 * 60 * 15 : 1000 * 60 * 2;

// ─── Local DB adapters ──────────────────────────────────────────────────────

function serverAgentToLocal(a: SerializedAgent): LocalAgent {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    description: a.description,
    email: a.email,
    image: a.image,
    metadata: a.metadata ?? {},
    parentId: a.parentId,
    pathIds: a.pathIds ?? [],
    depth: a.depth,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function serverResourceToLocal(r: SerializedResource): LocalResource {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    description: r.description,
    content: r.content,
    url: r.url,
    ownerId: r.ownerId,
    isPublic: r.isPublic,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    tags: (r.tags ?? []) as string[],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function localAgentToSerialized(a: LocalAgent): SerializedAgent {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    description: a.description,
    email: a.email,
    image: a.image,
    metadata: a.metadata,
    parentId: a.parentId,
    pathIds: a.pathIds,
    depth: a.depth,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function localResourceToSerialized(r: LocalResource): SerializedResource {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    description: r.description,
    content: r.content,
    url: r.url,
    ownerId: r.ownerId,
    isPublic: r.isPublic,
    metadata: r.metadata,
    tags: r.tags,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Cache-first fetch pattern: read from IndexedDB instantly, then sync from server.
 * Returns local data immediately if available, updates when server responds.
 */
async function syncAgentsByType(
  type: string,
  fetcher: (limit: number) => Promise<SerializedAgent[]>,
  limit: number
): Promise<{ local: SerializedAgent[]; remote: Promise<SerializedAgent[]> }> {
  const cacheKey = `agents.${type}`;
  const local = await getLocalAgentsByType(type, limit);

  const remote = (async () => {
    if (await isStale(cacheKey)) {
      const fresh = await fetcher(limit);
      await upsertAgents(fresh.map(serverAgentToLocal));
      await markSynced(cacheKey, fresh.length);
      return fresh;
    }
    return local.map(localAgentToSerialized);
  })();

  return { local: local.map(localAgentToSerialized), remote };
}
/** BroadcastChannel name used for same-origin tab synchronization. */
const GRAPH_SYNC_CHANNEL = "rivr-graph-sync";
/** LocalStorage key used as a BroadcastChannel fallback signal. */
const GRAPH_SYNC_STORAGE_KEY = "rivr-graph-sync-signal";

function emitGraphSync(message: GraphSyncMessage): void {
  if (typeof window === "undefined") return;
  try {
    if ("BroadcastChannel" in window) {
      // BroadcastChannel provides low-latency same-origin tab cache coordination.
      const bc = new BroadcastChannel(GRAPH_SYNC_CHANNEL);
      bc.postMessage(message);
      bc.close();
    }
  } catch {
    // Ignore browser/runtime issues.
  }
  try {
    // localStorage "storage" events provide a compatibility fallback transport.
    window.localStorage.setItem(GRAPH_SYNC_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Invalidates graph cache keys by prefix and notifies other tabs.
 *
 * @param keyPrefix - Cache key prefix to invalidate, defaults to all `graph.*` keys.
 * @returns No value.
 * @throws {Error} Does not intentionally throw; browser API failures are swallowed.
 * @example
 * invalidateGraphCache("graph.homeFeed.");
 */
export function invalidateGraphCache(keyPrefix = "graph."): void {
  if (typeof window === "undefined") return;
  emitGraphSync({ type: "invalidate", key: keyPrefix, ts: Date.now() });
}

function readGraphCache<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || parsed.v !== GRAPH_CACHE_VERSION) return null;
    // TTL expiry prevents long-lived stale data from surviving app/session drift.
    if (Date.now() - parsed.ts > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeGraphCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    // Store version + timestamp so reads can enforce migration and TTL guarantees.
    const payload: CacheEntry<T> = { v: GRAPH_CACHE_VERSION, ts: Date.now(), data };
    window.sessionStorage.setItem(key, JSON.stringify(payload));
    emitGraphSync({ type: "cache-write", key, ts: payload.ts });
  } catch {
    // Ignore storage quota errors.
  }
}

function useActiveRefresh(intervalMs = ACTIVE_REFRESH_MS): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // In dev mode, disable active refresh entirely — Next.js dev server evicts
    // compiled routes from memory after inactivity, and background refresh triggers
    // cause 404s when the server can't find the evicted route module.
    if (process.env.NODE_ENV === "development") return;

    const onFocus = () => setTick((prev) => prev + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Refresh when tab becomes visible to avoid showing stale background data.
        setTick((prev) => prev + 1);
      }
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setTick((prev) => prev + 1);
      }
    }, intervalMs);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return tick;
}

function useGraphSyncTick(shouldReact: (cacheKey: string) => boolean): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bumpIfRelevant = (cacheKey: string) => {
      if (shouldReact(cacheKey)) {
        setTick((prev) => prev + 1);
      }
    };

    let bc: BroadcastChannel | null = null;
    if ("BroadcastChannel" in window) {
      bc = new BroadcastChannel(GRAPH_SYNC_CHANNEL);
      bc.onmessage = (event: MessageEvent<GraphSyncMessage>) => {
        const msg = event.data;
        if (!msg?.key) return;
        bumpIfRelevant(msg.key);
      };
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== GRAPH_SYNC_STORAGE_KEY || !event.newValue) return;
      try {
        const msg = JSON.parse(event.newValue) as GraphSyncMessage;
        if (!msg?.key) return;
        bumpIfRelevant(msg.key);
      } catch {
        // Ignore malformed payloads so one bad writer does not break all listeners.
      }
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      bc?.close();
    };
  }, [shouldReact]);

  return tick;
}

/**
 * Fetches people from the semantic graph with session cache and sync updates.
 *
 * @param limit - Maximum number of people to fetch.
 * @returns Hook state containing `people` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { people, state } = usePeople(25);
 */
export function usePeople(limit = 50) {
  const [people, setPeople] = useState<User[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.people."));

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `graph.people.${limit}`;

    // Phase 1: Instant read from local IndexedDB
    getLocalAgentsByType("person", limit).then((local) => {
      if (cancelled) return;
      if (local.length > 0) {
        setPeople(local.map((a) => agentToUser(localAgentToSerialized(a))));
        setState("loaded");
      } else {
        // Fallback to sessionStorage while IndexedDB populates
        const cached = readGraphCache<User[]>(cacheKey);
        if (cached) {
          setPeople(cached);
          setState("loaded");
        } else {
          startTransition(() => setState("loading"));
        }
      }
    });

    // Phase 2: Background sync from server, update local DB + UI
    fetchPeople(limit)
      .then(async (agents) => {
        if (cancelled) return;
        const mapped = agents.map(agentToUser);
        setPeople(mapped);
        writeGraphCache(cacheKey, mapped);
        setState("loaded");
        // Persist to IndexedDB for offline access
        await upsertAgents(agents.map(serverAgentToLocal));
        await markSynced("agents.person", agents.length);
      })
      .catch(() => {
        if (cancelled) return;
        // If server fails but we have local data, stay loaded
        if (people.length === 0) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [limit, syncTick]);

  return { people, state };
}

/**
 * Fetches groups from the semantic graph with session cache and sync updates.
 *
 * @param limit - Maximum number of groups to fetch.
 * @returns Hook state containing `groups` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { groups, state } = useGroups(25);
 */
export function useGroups(limit = 50) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.groups."));

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `graph.groups.${limit}`;

    getLocalAgentsByType("organization", limit).then((local) => {
      if (cancelled) return;
      // Filter out basin/locale place-type agents — they belong in the locale selector, not group feeds.
      const nonPlaceGroups = local.filter((a) => {
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        return typeof meta.placeType !== "string";
      });
      if (nonPlaceGroups.length > 0) {
        setGroups(nonPlaceGroups.map((a) => agentToGroup(localAgentToSerialized(a))));
        setState("loaded");
      } else {
        const cached = readGraphCache<Group[]>(cacheKey);
        if (cached) { setGroups(cached); setState("loaded"); }
        else startTransition(() => setState("loading"));
      }
    });

    fetchGroups(limit)
      .then(async (agents) => {
        if (cancelled) return;
        const mapped = agents.map(agentToGroup);
        setGroups(mapped);
        writeGraphCache(cacheKey, mapped);
        setState("loaded");
        await upsertAgents(agents.map(serverAgentToLocal));
        await markSynced("agents.organization", agents.length);
      })
      .catch(() => {
        if (cancelled) return;
        if (groups.length === 0) setState("error");
      });

    return () => { cancelled = true; };
  }, [limit, syncTick]);

  return { groups, state };
}

/**
 * Fetches events from the semantic graph with session cache and sync updates.
 *
 * @param limit - Maximum number of events to fetch.
 * @returns Hook state containing `events` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { events, state } = useEvents(10);
 */
export function useEvents(limit = 50) {
  const [events, setEvents] = useState<GraphEvent[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.events."));

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `graph.events.${limit}`;

    getLocalAgentsByType("event", limit).then((local) => {
      if (cancelled) return;
      if (local.length > 0) {
        setEvents(local.map((a) => agentToEvent(localAgentToSerialized(a))));
        setState("loaded");
      } else {
        const cached = readGraphCache<GraphEvent[]>(cacheKey);
        if (cached) { setEvents(cached); setState("loaded"); }
        else startTransition(() => setState("loading"));
      }
    });

    fetchEvents(limit)
      .then(async (agents) => {
        if (cancelled) return;
        const mapped = agents.map(agentToEvent);
        setEvents(mapped);
        writeGraphCache(cacheKey, mapped);
        setState("loaded");
        await upsertAgents(agents.map(serverAgentToLocal));
        await markSynced("agents.event", agents.length);
      })
      .catch(() => {
        if (cancelled) return;
        if (events.length === 0) setState("error");
      });

    return () => { cancelled = true; };
  }, [limit, syncTick]);

  return { events, state };
}

/**
 * Fetches places/chapters from the semantic graph with cache and sync updates.
 *
 * @param limit - Maximum number of places to fetch.
 * @returns Hook state containing `places` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { places, state } = usePlaces(25);
 */
export function usePlaces(limit = 50) {
  const [places, setPlaces] = useState<GraphPlace[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.places."));

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `graph.places.${limit}`;

    getLocalAgentsByType("place", limit).then((local) => {
      if (cancelled) return;
      if (local.length > 0) {
        setPlaces(local.map((a) => agentToPlace(localAgentToSerialized(a))));
        setState("loaded");
      } else {
        const cached = readGraphCache<GraphPlace[]>(cacheKey);
        if (cached) { setPlaces(cached); setState("loaded"); }
        else startTransition(() => setState("loading"));
      }
    });

    fetchPlaces(limit)
      .then(async (agents) => {
        if (cancelled) return;
        const mapped = agents.map(agentToPlace);
        setPlaces(mapped);
        writeGraphCache(cacheKey, mapped);
        setState("loaded");
        await upsertAgents(agents.map(serverAgentToLocal));
        await markSynced("agents.place", agents.length);
      })
      .catch(() => {
        if (cancelled) return;
        if (places.length === 0) setState("error");
      });

    return () => { cancelled = true; };
  }, [limit, syncTick]);

  return { places, state };
}

/**
 * Fetches marketplace listings and adapts resources to listing DTOs.
 *
 * @param limit - Maximum number of listings to fetch.
 * @returns Hook state containing `listings` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { listings, state } = useMarketplace(20);
 */
export function useMarketplace(limit = 50) {
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.marketplace."));

  useEffect(() => {
    // Skip fetch entirely when limit is 0 (e.g. event-scoped composers that
    // don't need marketplace data).
    if (limit <= 0) {
      setState("loaded");
      return;
    }
    let cancelled = false;
    const cacheKey = `graph.marketplace.${limit}`;

    // Phase 1: Instant read from local IndexedDB
    getLocalResourcesByType("listing", limit).then((local) => {
      if (cancelled) return;
      if (local.length > 0) {
        setListings(local.map((r) => resourceToMarketplaceListing(localResourceToSerialized(r))));
        setState("loaded");
      } else {
        const cached = readGraphCache<MarketplaceListing[]>(cacheKey);
        if (cached) { setListings(cached); setState("loaded"); }
        else startTransition(() => setState("loading"));
      }
    });

    // Phase 2: Background sync from server
    fetchMarketplaceListings(limit)
      .then(async (results) => {
        if (cancelled) return;
        const mapped = results.map((r) => {
          const row = r as SerializedResource & { ownerName?: string; ownerImage?: string };
          // Construct a synthetic owner agent from the joined owner fields so the
          // adapter can populate seller info instead of falling back to "Unknown Seller".
          const syntheticOwner: SerializedAgent | undefined =
            row.ownerName
              ? {
                  id: row.ownerId,
                  name: row.ownerName,
                  type: "person",
                  description: null,
                  email: null,
                  image: row.ownerImage ?? null,
                  metadata: {},
                  parentId: null,
                  depth: 0,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                }
              : undefined;
          return resourceToMarketplaceListing(row, syntheticOwner);
        });
        setListings(mapped);
        writeGraphCache(cacheKey, mapped);
        setState("loaded");
        await upsertResources((results as SerializedResource[]).map(serverResourceToLocal));
        await markSynced("resources.marketplace", results.length);
      })
      .catch(() => {
        if (cancelled) return;
        if (listings.length === 0) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [limit, syncTick]);

  return { listings, state };
}

/**
 * Fetches post-like resources and applies optional scope filtering.
 *
 * @param limit - Maximum number of resources to scan for posts.
 * @param scopeId - Optional scope identifier used to filter mapped posts.
 * @returns Hook state containing scoped `posts` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { posts, state } = usePosts(50, "chapter-oakland");
 */
export function usePosts(limit = 50, scopeId?: string, options?: { enabled?: boolean }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.posts."));
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      startTransition(() => setState("idle"));
      return;
    }

    let cancelled = false;
    let serverResolved = false;
    const cacheKey = `graph.posts.${limit}.${scopeId || "all"}`;

    // Phase 1: Instant read from local IndexedDB (skipped if server already responded)
    Promise.all([
      getLocalResourcesByType("post", limit),
      getLocalResourcesByType("note", limit),
    ]).then(([localPosts, localNotes]) => {
      if (cancelled || serverResolved) return;
      const allLocal = [...localPosts, ...localNotes];
      if (allLocal.length > 0) {
        const mappedPosts = allLocal.map((r) => resourceToPost(localResourceToSerialized(r)));
        const scopedPosts =
          scopeId && scopeId !== "all"
            ? mappedPosts.filter((post) =>
                post.chapterTags?.includes(scopeId) ||
                post.groupTags?.includes(scopeId) ||
                post.tags?.includes(scopeId)
              )
            : mappedPosts;
        setPosts(scopedPosts as Post[]);
        setState("loaded");
      } else {
        const cached = readGraphCache<Post[]>(cacheKey);
        if (cached && !serverResolved) { setPosts(cached); setState("loaded"); }
        else if (!serverResolved) startTransition(() => setState("loading"));
      }
    });

    // Phase 2: Background sync from server
    fetchPublicResources(limit)
      .then(async (resources) => {
        if (cancelled) return;
        serverResolved = true;

        const postResources = resources.filter((resource) => {
          const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
          return metadata.entityType === "post" || resource.type === "post" || resource.type === "note";
        });

        if (postResources.length > 0) {
          const mappedPosts = postResources.map((resource) => resourceToPost(resource as SerializedResource));
          const scopedPosts =
            scopeId && scopeId !== "all"
              ? mappedPosts.filter((post) =>
                  post.chapterTags?.includes(scopeId) ||
                  post.groupTags?.includes(scopeId) ||
                  post.tags?.includes(scopeId)
                )
              : mappedPosts;
          const nextPosts = scopedPosts as Post[];
          setPosts(nextPosts);
          writeGraphCache(cacheKey, nextPosts);
        } else {
          setPosts([]);
          writeGraphCache(cacheKey, []);
        }

        setState("loaded");
        // Persist to IndexedDB for offline access
        await upsertResources(resources.map((r) => serverResourceToLocal(r as SerializedResource)));
        await markSynced("resources.public", resources.length);
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, limit, scopeId, syncTick]);

  return { posts, state };
}

/**
 * Fetches the home feed bundle (people/groups/events/places/projects/marketplace).
 *
 * Uses active refresh and cross-tab cache sync to keep high-traffic home surfaces
 * up to date without forcing blocking reloads.
 *
 * @param limit - Maximum number of items per feed segment.
 * @param scopeId - Optional scope id; when set (and not `"all"`), uses scoped feed action.
 * @returns Hook state containing `data`, async `state`, and optional `error`.
 * @throws {Error} Does not intentionally throw; failures are surfaced via `state`/`error`.
 * @example
 * const { data, state, error } = useHomeFeed(20, "all");
 */
export function useHomeFeed(limit = 20, scopeId?: string, options?: { enabled?: boolean }) {
  const [data, setData] = useState<{
    people: User[];
    groups: Group[];
    events: GraphEvent[];
    places: GraphPlace[];
    projects: GraphProject[];
    marketplace: MarketplaceListing[];
  }>({
    people: [],
    groups: [],
    events: [],
    places: [],
    projects: [],
    marketplace: [],
  });
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const refreshTick = useActiveRefresh();
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.homeFeed."));
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      startTransition(() => setState("idle"));
      setError(null);
      return;
    }

    let cancelled = false;
    let serverResolved = false;
    const cacheKey = `graph.homeFeed.${scopeId || "all"}.${limit}`;

    // Phase 1: Instant read from local IndexedDB across all entity types.
    // Skipped if the server already responded (prevents stale-data flash).
    Promise.all([
      getLocalAgentsByType("person", limit),
      getLocalAgentsByType("organization", limit),
      getLocalAgentsByType("event", limit),
      getLocalAgentsByType("place", limit),
      getLocalAgentsByType("project", limit),
      getLocalResourcesByType("listing", limit),
    ]).then(([localPeople, localGroups, localEvents, localPlaces, localProjects, localListings]) => {
      if (cancelled || serverResolved) return;
      const hasLocal = localPeople.length + localGroups.length + localEvents.length + localPlaces.length > 0;
      if (hasLocal) {
        // Filter out basin/locale place-type agents from groups — they belong in the locale selector, not feeds.
        const nonPlaceGroups = localGroups.filter((a) => {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          return typeof meta.placeType !== "string";
        });
        setData({
          people: localPeople.map((a) => agentToUser(localAgentToSerialized(a))),
          groups: nonPlaceGroups.map((a) => agentToGroup(localAgentToSerialized(a))),
          events: localEvents.map((a) => agentToEvent(localAgentToSerialized(a))),
          places: localPlaces.map((a) => agentToPlace(localAgentToSerialized(a))),
          projects: localProjects.map((a) => agentToProject(localAgentToSerialized(a))),
          marketplace: localListings.map((r) => resourceToMarketplaceListing(localResourceToSerialized(r))),
        });
        setState("loaded");
        setError(null);
      } else {
        const cached = readGraphCache<{
          people: User[];
          groups: Group[];
          events: GraphEvent[];
          places: GraphPlace[];
          projects: GraphProject[];
          marketplace: MarketplaceListing[];
        }>(cacheKey, 1000 * 60 * 2);
        if (cached && !serverResolved) {
          setData(cached);
          setState("loaded");
          setError(null);
        } else if (!serverResolved) {
          startTransition(() => setState("loading"));
        }
      }
    });

    // Phase 2: Background sync from server
    const feedPromise =
      scopeId && scopeId !== "all"
        ? fetchScopedHomeFeed(scopeId, limit)
        : fetchHomeFeed(limit);

    feedPromise
      .then(async (feed) => {
        if (cancelled) return;
        serverResolved = true;
        try {
          const rawMarketplace = (feed as { marketplace?: { id: string; name: string; type: string; description: string | null; content: string | null; url: string | null; ownerId: string; isPublic: boolean; metadata: Record<string, unknown>; tags: string[]; createdAt: string; updatedAt: string; ownerName?: string; ownerImage?: string }[] }).marketplace ?? [];
          const nextData = {
            people: feed.people.map(agentToUser),
            groups: feed.groups.map(agentToGroup),
            events: feed.events.map(agentToEvent),
            places: feed.places.map(agentToPlace),
            projects: feed.projects.map(agentToProject),
            marketplace: rawMarketplace.map((item) =>
              resourceToMarketplaceListing(item as unknown as Parameters<typeof resourceToMarketplaceListing>[0])
            ),
          };
          setData(nextData);
          writeGraphCache(cacheKey, nextData);
          setError(null);
          setState("loaded");
          // Persist all agents and resources to IndexedDB
          const allAgents = [
            ...feed.people,
            ...feed.groups,
            ...feed.events,
            ...feed.places,
            ...feed.projects,
          ];
          await upsertAgents(allAgents.map(serverAgentToLocal));
          if (rawMarketplace.length > 0) {
            await upsertResources(rawMarketplace.map((r) => serverResourceToLocal(r as unknown as SerializedResource)));
          }
        } catch (adapterErr) {
          console.error("[useHomeFeed] Adapter transform failed:", adapterErr);
          setError(`Adapter error: ${String(adapterErr)}`);
          setState("error");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useHomeFeed] Server action failed:", err);
        setError(`Server action error: ${String(err)}`);
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, limit, scopeId, refreshTick, syncTick]);

  return { data, state, error };
}

/**
 * Searches agents by name using the graph search action.
 *
 * @param query - Search query string.
 * @param limit - Maximum number of results to return.
 * @returns Hook state containing serialized `results` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { results, state } = useAgentSearch(searchTerm, 20);
 */
export function useAgentSearch(query: string, limit = 20) {
  const [results, setResults] = useState<SerializedAgent[]>([]);
  const [state, setState] = useState<LoadState>("idle");

  useEffect(() => {
    if (!query || query.trim().length === 0) {
      startTransition(() => {
        setResults([]);
        setState("idle");
      });
      return;
    }

    let cancelled = false;

    // Phase 1: Instant local search from IndexedDB
    searchLocalAgents(query, limit).then((local) => {
      if (cancelled) return;
      if (local.length > 0) {
        setResults(local.map(localAgentToSerialized));
        setState("loaded");
      } else {
        startTransition(() => setState("loading"));
      }
    });

    // Phase 2: Server search for authoritative results
    searchAgentsByName(query, limit)
      .then(async (agents) => {
        if (cancelled) return;
        setResults(agents);
        setState("loaded");
        await upsertAgents(agents.map(serverAgentToLocal));
      })
      .catch(() => {
        if (cancelled) return;
        if (results.length === 0) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [query, limit]);

  return { results, state };
}

/**
 * Fetches a single agent by id with short-lived cache and sync invalidation.
 *
 * @param id - Agent id, or `null` to reset to idle/empty state.
 * @returns Hook state containing `agent` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { agent, state } = useAgent(selectedAgentId);
 */
export function useAgent(id: string | null) {
  const [agent, setAgent] = useState<SerializedAgent | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.agent."));

  useEffect(() => {
    if (!id) {
      startTransition(() => {
        setAgent(null);
        setState("idle");
      });
      return;
    }

    let cancelled = false;
    const cacheKey = `graph.agent.${id}`;

    // Phase 1: Instant local lookup from IndexedDB
    getLocalAgent(id).then((local) => {
      if (cancelled) return;
      if (local) {
        setAgent(localAgentToSerialized(local));
        setState("loaded");
      } else {
        const cached = readGraphCache<SerializedAgent | null>(cacheKey, 1000 * 60 * 2);
        if (cached) { setAgent(cached); setState("loaded"); }
        else startTransition(() => setState("loading"));
      }
    });

    // Phase 2: Server fetch for authoritative data
    fetchAgent(id)
      .then(async (result) => {
        if (cancelled) return;
        setAgent(result);
        writeGraphCache(cacheKey, result);
        setState("loaded");
        if (result) {
          await upsertAgents([serverAgentToLocal(result)]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [id, syncTick]);

  return { agent, state };
}

/**
 * Fetches basins and locales (chapters) in parallel for location navigation.
 *
 * @param _unused - This hook does not accept runtime parameters.
 * @returns Hook state with `{ basins, locales }` and async `state`.
 * @throws {Error} Does not intentionally throw; failures are captured as `state: "error"`.
 * @example
 * const { data, state } = useLocalesAndBasins();
 */
export function useLocalesAndBasins(options?: { enabled?: boolean }) {
  const [data, setData] = useState<{
    basins: Basin[];
    locales: Chapter[];
  }>({
    basins: [],
    locales: [],
  });
  const [state, setState] = useState<LoadState>("loading");
  const refreshTick = useActiveRefresh(1000 * 60 * 5);
  const syncTick = useGraphSyncTick((key) => key.startsWith("graph.localesBasins"));
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      startTransition(() => setState("idle"));
      return;
    }

    let cancelled = false;
    let serverResolved = false;
    const cacheKey = "graph.localesBasins";

    // Phase 1: Instant read from local IndexedDB (skipped if server already responded)
    Promise.all([
      getLocalAgentsByType("basin", 200),
      getLocalAgentsByType("locale", 200),
    ]).then(([localBasins, localLocales]) => {
      if (cancelled || serverResolved) return;
      if (localBasins.length > 0 || localLocales.length > 0) {
        setData({
          basins: localBasins.map((a) => agentToBasin(localAgentToSerialized(a))),
          locales: localLocales.map((a) => agentToLocale(localAgentToSerialized(a))),
        });
        setState("loaded");
      } else {
        const cached = readGraphCache<{ basins: Basin[]; locales: Chapter[] }>(cacheKey, 1000 * 60 * 15);
        if (cached && !serverResolved) { setData(cached); setState("loaded"); }
      }
    });

    // Phase 2: Background sync from server
    Promise.all([fetchBasins(), fetchLocales()])
      .then(async ([basinAgents, localeAgents]) => {
        if (cancelled) return;
        serverResolved = true;

        const basins = basinAgents.map(agentToBasin);
        const locales = localeAgents.map(agentToLocale);

        const next = { basins, locales };
        setData(next);
        writeGraphCache(cacheKey, next);
        setState("loaded");
        // Persist to IndexedDB
        await upsertAgents([...basinAgents, ...localeAgents].map(serverAgentToLocal));
        await markSynced("agents.basin", basinAgents.length);
        await markSynced("agents.locale", localeAgents.length);
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshTick, syncTick]);

  return { data, state };
}
