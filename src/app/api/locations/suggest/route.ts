import { NextResponse } from "next/server";
import { getPlacesByPlaceType } from "@/lib/queries/agents";
import type { Agent } from "@/db/schema";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/locations/suggest?q=<text>&limit=<n>
//
// Local, sovereign-safe location autocomplete. The global app exposes a richer
// geocoder; this sovereign instance has no such service and must NOT call the
// global hub for location lookups (per the repo contributing rules).
//
// Instead we serve suggestions from the local semantic graph's place-type
// nodes (locales/chapters and basins/regions). When nothing matches we return
// an empty list so the autocomplete degrades gracefully rather than erroring.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const PLACE_FETCH_LIMIT = 200;

interface LocationSuggestion {
  id: string;
  label: string;
  name?: string;
  locality?: string;
  adminRegion?: string;
  countryCode?: string;
  lat?: number;
  lon?: number;
  source?: string;
}

function parseLimit(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function agentToSuggestion(agent: Agent, source: string): LocationSuggestion {
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  const adminRegion =
    typeof meta.adminRegion === "string"
      ? meta.adminRegion
      : typeof meta.basinName === "string"
        ? meta.basinName
        : undefined;
  const locality = typeof meta.locality === "string" ? meta.locality : undefined;
  const countryCode =
    typeof meta.countryCode === "string" ? meta.countryCode : undefined;
  const lat = typeof meta.lat === "number" ? meta.lat : undefined;
  const lon = typeof meta.lon === "number" ? meta.lon : undefined;
  const labelParts = [agent.name, adminRegion].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return {
    id: agent.id,
    label: labelParts.join(", ") || agent.name,
    name: agent.name,
    locality,
    adminRegion,
    countryCode,
    lat,
    lon,
    source,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = parseLimit(url.searchParams.get("limit"));

  if (query.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const [locales, basins] = await Promise.all([
      getPlacesByPlaceType("chapter", PLACE_FETCH_LIMIT),
      getPlacesByPlaceType("basin", PLACE_FETCH_LIMIT),
    ]);

    const matches = (agents: Agent[], source: string): LocationSuggestion[] =>
      agents
        .filter((agent) => {
          const name = (agent.name ?? "").toLowerCase();
          const meta = (agent.metadata ?? {}) as Record<string, unknown>;
          const locality =
            typeof meta.locality === "string" ? meta.locality.toLowerCase() : "";
          return name.includes(query) || locality.includes(query);
        })
        .map((agent) => agentToSuggestion(agent, source));

    // Deduplicate by id, locales first (more specific than basins/regions).
    const seen = new Set<string>();
    const suggestions: LocationSuggestion[] = [];
    for (const suggestion of [...matches(locales, "locale"), ...matches(basins, "basin")]) {
      if (seen.has(suggestion.id)) continue;
      seen.add(suggestion.id);
      suggestions.push(suggestion);
      if (suggestions.length >= limit) break;
    }

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error("[api/locations/suggest] failed:", error);
    // Degrade gracefully — the autocomplete treats a non-ok / empty list as "no
    // suggestions" rather than surfacing an error to the user.
    return NextResponse.json({ suggestions: [] });
  }
}
