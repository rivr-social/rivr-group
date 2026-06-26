/**
 * @fileoverview Luma (lu.ma) event-publish connector for the group connector
 * lane (platform-evolution Wave 3 T3.4).
 *
 * The agent holds a Luma API key on its `user_connectors` row (encrypted at
 * rest by the secret-box envelope). Given a RIVR event Resource, this PUSHES
 * that event OUT to Luma — one-way (RIVR → Luma) by default — and stamps the
 * Resource's `metadata.source` block with `provider: "luma"` + the returned
 * Luma `event_id`, so a re-publish UPDATES the same Luma event instead of
 * creating a duplicate. The pushed event's description carries a clickable
 * backlink to the canonical RIVR event.
 *
 * This is the typed-lane outbound mirror: provenance is `rivr_outbound`
 * (we wrote the provider item), `syncMode: "one-way"`. RSVP/two-way pullback
 * (T3.4 "later") is deliberately out of scope here.
 *
 * Grounded against the Luma public API (OpenAPI 3.1 at
 * https://public-api.luma.com/openapi.json):
 *   - POST /v1/events/create  → { id }            (required: name, start_at, timezone)
 *   - POST /v1/events/update  → {}                (required: event_id)
 *   - GET  /v1/events/get?event_id=…              (returns the public `url`)
 * Auth header is `x-luma-api-key` (NOT a Bearer token).
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { resources, userConnectors } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto/secret-box";
import { resourceToGoogleEvent } from "@/lib/google/calendar-mapper";
import {
  buildSourceBlock,
  getSourceBlock,
  touchSync,
  withSourceBlock,
  type SourceBlock,
} from "@/lib/resources/source-block";
import { absoluteUrl } from "@/lib/structured-data";

const LUMA_PROVIDER = "luma" as const;
const LUMA_API_BASE = "https://public-api.luma.com/v1";
/**
 * Luma requires an IANA timezone on create. When a RIVR event omits one we fall
 * back to UTC explicitly rather than guess the organizer's zone — the naive
 * `date`+`time` is then interpreted as UTC, which is unambiguous and correct to
 * the minute even if the display zone differs.
 */
const DEFAULT_LUMA_TIMEZONE = "UTC" as const;

interface LumaEventCreatePayload {
  name: string;
  start_at: string;
  timezone: string;
  end_at?: string;
  description_md?: string;
  meeting_url?: string;
}

interface LumaCreateResponse {
  id: string;
}

interface LumaGetResponse {
  id?: string;
  url?: string;
  start_at?: string;
  end_at?: string;
}

/** Minimal RIVR event row this connector reads. */
interface EventResourceRow {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
}

/** Outcome of a single Luma publish. */
export interface LumaPublishResult {
  provider: "luma";
  /** `created` on first push, `updated` on a re-push of an already-linked event. */
  outcome: "created" | "updated";
  resourceId: string;
  /** Luma event id (starts with `evt-`). */
  externalId: string;
  /** Public lu.ma URL of the pushed event, when Luma returns one. */
  externalUrl: string | null;
}

async function lumaJson<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LUMA_API_BASE}${path}`, {
    ...init,
    headers: {
      "x-luma-api-key": apiKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Luma access denied. Reconnect the Luma connector with a valid API key.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Luma API error (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/** Resolves and decrypts the Luma API key stored for an agent. */
async function resolveLumaApiKey(targetAgentId: string): Promise<string> {
  const [connector] = await db
    .select({ accessToken: userConnectors.accessToken })
    .from(userConnectors)
    .where(and(eq(userConnectors.userAgentId, targetAgentId), eq(userConnectors.provider, LUMA_PROVIDER)))
    .limit(1);
  const key = decryptSecret(connector?.accessToken);
  if (!key) throw new Error("No Luma connector is configured for this agent.");
  return key;
}

/** Loads an event-type Resource the agent owns, or throws a precise error. */
async function loadOwnedEvent(targetAgentId: string, resourceId: string): Promise<EventResourceRow> {
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
      type: resources.type,
      ownerId: resources.ownerId,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);
  if (!row) throw new Error("Event resource not found.");
  if (row.ownerId !== targetAgentId) {
    throw new Error("Only the event owner can publish it to Luma.");
  }
  if (row.type !== "event") {
    throw new Error("Only event resources can be published to Luma.");
  }
  return { id: row.id, name: row.name, description: row.description, metadata: row.metadata };
}

/**
 * Builds the Luma create/update payload from a RIVR event Resource, reusing the
 * shared {@link resourceToGoogleEvent} mapper for canonical start/end/timezone
 * derivation (single source of date logic) and appending a backlink to the
 * canonical RIVR event in the description.
 */
export function buildLumaEventPayload(resource: EventResourceRow): LumaEventCreatePayload {
  const normalized = resourceToGoogleEvent({
    id: resource.id,
    name: resource.name,
    description: resource.description,
    metadata: resource.metadata,
  });

  const backlink = absoluteUrl(`/events/${resource.id}`);
  const baseDescription = (normalized.description ?? "").trim();
  const description_md = [baseDescription, `View on RIVR: ${backlink}`]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const meetingUrl =
    typeof normalized.location === "string" && /^https?:\/\//i.test(normalized.location)
      ? normalized.location
      : undefined;

  return {
    name: normalized.summary,
    start_at: normalized.start.dateTime,
    timezone: normalized.start.timeZone ?? DEFAULT_LUMA_TIMEZONE,
    end_at: normalized.end.dateTime,
    description_md,
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
  };
}

/** Fetches a Luma event's public URL (best-effort; returns null on failure). */
async function fetchLumaEventUrl(apiKey: string, eventId: string): Promise<string | null> {
  try {
    const event = await lumaJson<LumaGetResponse>(
      apiKey,
      `/events/get?event_id=${encodeURIComponent(eventId)}`,
    );
    return event.url ?? null;
  } catch {
    return null;
  }
}

/** Persists the source block onto the event Resource's metadata. */
async function stampSourceBlock(resourceId: string, metadata: Record<string, unknown> | null, source: SourceBlock): Promise<void> {
  await db
    .update(resources)
    .set({ metadata: withSourceBlock(metadata, source), updatedAt: new Date() })
    .where(eq(resources.id, resourceId));
}

/**
 * Publishes (or re-publishes) a RIVR event Resource to Luma.
 *
 * First publish: POST /v1/events/create, then stamp `metadata.source` with the
 * returned Luma event id. Re-publish (source block already present): POST
 * /v1/events/update with the stored `event_id`, refreshing the source block.
 * Idempotent by construction — the stored external id routes a re-push to
 * `update`, never a second `create`.
 *
 * @throws {Error} When no connector is configured, the event is missing/owned
 *   by another agent/not an event, or the Luma API rejects the request.
 */
export async function publishEventToLuma(
  targetAgentId: string,
  resourceId: string,
): Promise<LumaPublishResult> {
  const trimmedId = resourceId.trim();
  if (!trimmedId) throw new Error("An event resource id is required.");
  const apiKey = await resolveLumaApiKey(targetAgentId);
  const event = await loadOwnedEvent(targetAgentId, trimmedId);
  const payload = buildLumaEventPayload(event);
  const existing = getSourceBlock(event.metadata);
  const fingerprint = `${payload.name}|${payload.start_at}|${payload.end_at ?? ""}|${payload.description_md ?? ""}`;

  // Re-publish: the event is already linked to a Luma event → update in place.
  if (existing && existing.provider === LUMA_PROVIDER && existing.externalId) {
    await lumaJson<unknown>(apiKey, "/events/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: existing.externalId, ...payload }),
    });
    const externalUrl = (await fetchLumaEventUrl(apiKey, existing.externalId)) ?? existing.externalUrl;
    const refreshed = touchSync(existing, {
      provenance: "rivr_outbound",
      externalUpdatedAt: new Date(),
      externalUrl,
      contentHash: undefined,
      content: fingerprint,
    });
    await stampSourceBlock(event.id, event.metadata, refreshed);
    return {
      provider: LUMA_PROVIDER,
      outcome: "updated",
      resourceId: event.id,
      externalId: existing.externalId,
      externalUrl,
    };
  }

  // First publish: create the Luma event and link it back.
  const created = await lumaJson<LumaCreateResponse>(apiKey, "/events/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const externalUrl = await fetchLumaEventUrl(apiKey, created.id);
  const source = buildSourceBlock({
    provider: LUMA_PROVIDER,
    externalId: created.id,
    lane: "typed",
    syncMode: "one-way",
    provenance: "rivr_outbound",
    externalUrl,
    externalUpdatedAt: new Date(),
    content: fingerprint,
  });
  await stampSourceBlock(event.id, event.metadata, source);
  return {
    provider: LUMA_PROVIDER,
    outcome: "created",
    resourceId: event.id,
    externalId: created.id,
    externalUrl,
  };
}

/** Providers whose connector supports pushing a RIVR event out to the provider. */
export const EVENT_PUBLISH_PROVIDERS = [LUMA_PROVIDER] as const;

/**
 * Dispatches an event publish for the given provider. Currently only Luma is
 * wired; other providers throw a clear "not supported" error so the route
 * surfaces an honest message rather than silently succeeding.
 */
export async function runConnectorEventPublish(
  targetAgentId: string,
  provider: string,
  resourceId: string,
): Promise<LumaPublishResult> {
  if (provider === LUMA_PROVIDER) {
    return publishEventToLuma(targetAgentId, resourceId);
  }
  throw new Error(`Event publish is not supported for the ${provider} connector.`);
}
