"use client";

/**
 * useGlobalLocales — client-side hook that fetches the canonical locale
 * catalog from the GLOBAL instance's federation registry.
 *
 * Ticket #109 — the top-bar locale dropdown must show the same list of
 * locales on every instance (person, group, locale, region, or global),
 * not whatever happens to live in the local database.
 *
 * Resolution path, in order:
 *   1. `GET {GLOBAL_BASE_URL}/api/federation/registry?kind=locale`
 *      — the intended canonical surface.
 *   2. `GET {GLOBAL_BASE_URL}/api/federation/registry`
 *      — full registry; we then filter to `instanceType === "locale"`.
 *      This is the current global-registry contract and is always present.
 *
 * Results are cached in module-level memory for 5 minutes so that
 * navigating between pages on the same session does not re-hit global.
 */

import { useEffect, useState } from "react";
import { GLOBAL_BASE_URL } from "@/lib/global-base-url";

export interface GlobalLocaleEntry {
  /** Stable locale identifier (instance UUID or slug). */
  id: string;
  /** URL-safe slug as registered on global. */
  slug: string;
  /** Human-readable display name. */
  name: string;
  /** Optional basin id the locale belongs to (for grouping). */
  basinId?: string;
  /** Optional basin display name (denormalized for grouping without an extra fetch). */
  basinName?: string;
  /** Optional locale avatar/image URL. */
  image?: string | null;
  /** Whether this locale is marked as "commons" on global. */
  isCommons?: boolean;
  /** Absolute base URL of the canonical locale instance, if different from global. */
  baseUrl?: string | null;
}

export type GlobalLocalesLoadState = "idle" | "loading" | "loaded" | "error";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  locales: GlobalLocaleEntry[];
}

let moduleCache: CacheEntry | null = null;
let inflight: Promise<GlobalLocaleEntry[]> | null = null;

function isFresh(entry: CacheEntry | null): entry is CacheEntry {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Low-level fetch. Tries the `?kind=locale` filtered endpoint first, then
 * falls back to the full registry and filters client-side.
 */
async function fetchGlobalLocales(): Promise<GlobalLocaleEntry[]> {
  const base = GLOBAL_BASE_URL;

  const attempts: Array<() => Promise<Response>> = [
    () => fetch(`${base}/api/federation/registry?kind=locale`, { cache: "no-store" }),
    () => fetch(`${base}/api/federation/registry`, { cache: "no-store" }),
  ];

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      const res = await attempt();
      if (!res.ok) {
        lastError = new Error(`global registry responded ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        success?: boolean;
        instances?: Array<Record<string, unknown>>;
        locales?: Array<Record<string, unknown>>;
      };

      const rawRows = Array.isArray(data.locales)
        ? data.locales
        : Array.isArray(data.instances)
          ? data.instances
          : [];

      const locales: GlobalLocaleEntry[] = rawRows
        .filter((row) => {
          const type = row.instanceType ?? row.kind;
          return typeof type === "string" ? type === "locale" : true;
        })
        .map((row) => {
          const id = String(row.instanceId ?? row.id ?? row.slug ?? "");
          const slug = String(row.slug ?? id);
          const name = String(row.displayName ?? row.name ?? slug);
          const basinId =
            typeof row.basinId === "string"
              ? row.basinId
              : typeof row.basin === "string"
                ? row.basin
                : undefined;
          const basinName =
            typeof row.basinName === "string" ? row.basinName : undefined;
          const image =
            typeof row.image === "string"
              ? row.image
              : typeof row.avatarUrl === "string"
                ? row.avatarUrl
                : null;
          const isCommons = row.isCommons === true;
          const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl : null;
          return { id, slug, name, basinId, basinName, image, isCommons, baseUrl };
        })
        .filter((row) => !!row.id);

      return locales;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to load global locales");
}

/**
 * React hook. Returns the cached global locale list, loading state, and
 * the target href pattern used for navigating to a given locale on global.
 */
export function useGlobalLocales(): {
  locales: GlobalLocaleEntry[];
  state: GlobalLocalesLoadState;
  error: string | null;
  refetch: () => void;
} {
  const [locales, setLocales] = useState<GlobalLocaleEntry[]>(() =>
    isFresh(moduleCache) ? moduleCache!.locales : [],
  );
  const [state, setState] = useState<GlobalLocalesLoadState>(() =>
    isFresh(moduleCache) ? "loaded" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (isFresh(moduleCache) && refetchTick === 0) {
      setLocales(moduleCache!.locales);
      setState("loaded");
      return;
    }

    let cancelled = false;
    setState("loading");

    const promise = inflight ?? fetchGlobalLocales();
    if (!inflight) inflight = promise;

    promise
      .then((rows) => {
        moduleCache = { fetchedAt: Date.now(), locales: rows };
        if (cancelled) return;
        setLocales(rows);
        setError(null);
        setState("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setState("error");
      })
      .finally(() => {
        if (inflight === promise) inflight = null;
      });

    return () => {
      cancelled = true;
    };
  }, [refetchTick]);

  return {
    locales,
    state,
    error,
    refetch: () => setRefetchTick((n) => n + 1),
  };
}

/**
 * Build the URL to open on global when the user selects a locale from
 * the dropdown.
 *
 * Uses the home-route pattern `/?locale=<slug>` — global's home-client
 * already reads `selectedLocale` from its app context and filters by it,
 * and passing a hint via the query string lets the landing render
 * locale-scoped.
 */
export function globalLocaleHref(localeSlugOrId: string): string {
  if (!localeSlugOrId || localeSlugOrId === "all") {
    return `${GLOBAL_BASE_URL}/`;
  }
  const encoded = encodeURIComponent(localeSlugOrId);
  return `${GLOBAL_BASE_URL}/?locale=${encoded}`;
}
