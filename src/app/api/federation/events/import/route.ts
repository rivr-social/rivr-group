/**
 * Federation event import API route.
 *
 * Purpose:
 * - Ingests event batches from a peer into the authenticated local node context.
 * - Tees signed authority events (credential.updated, authority.revoke,
 *   successor.authority.claim, credential.tempwrite.from-global) into the
 *   local `authority_event_cache` so the federation authority guard can
 *   enforce revocation on session creation and sensitive mutations.
 *
 * Key exports:
 * - `POST`: Validates payload, enforces per-peer rate limits, imports events,
 *   and projects authority events into the guard cache.
 *
 * Dependencies:
 * - `authorizeFederationRequest` for federation request authentication.
 * - `rateLimit` and `RATE_LIMITS` for abuse protection on import workloads.
 * - `ensureLocalNode` and `importFederationEvents` for scoped import execution.
 * - `persistAuthorityEvent` for guard-cache projection (rivr-group #1).
 * - HTTP status constants from `@/lib/http-status`.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import type { VisibilityLevel } from "@/db/schema";
import { ensureLocalNode, importFederationEvents } from "@/lib/federation";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
} from "@/lib/http-status";
import {
  AUTHORITY_EVENT_TYPES,
  isRecognizedAuthorityEventType,
  persistAuthorityEvent,
} from "@/lib/federation/authority-guard";

interface ImportEvent {
  id?: string;
  entityType: string;
  eventType: string;
  visibility: VisibilityLevel;
  payload: Record<string, unknown>;
  signature?: string;
}

interface ImportPayload {
  fromPeerSlug: string;
  events: ImportEvent[];
}

/**
 * Extract a string field from a payload, tolerant to missing/non-string values.
 */
function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extract an integer field from a payload, tolerant to missing/non-numeric values.
 */
function readInt(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Project a verified authority event into the local guard cache.
 * Called after `importFederationEvents` has performed signature + replay checks.
 */
async function projectAuthorityEvent(
  event: ImportEvent,
  fromPeerSlug: string,
): Promise<void> {
  const payload = event.payload ?? {};
  const agentId = readString(payload, "agentId") ?? readString(payload, "actorId");
  const homeBaseUrl = readString(payload, "homeBaseUrl");
  const signedBy = readString(payload, "signedBy") ?? fromPeerSlug;

  if (!agentId || !homeBaseUrl) {
    console.warn(
      `[federation/events/import] Authority event ${event.eventType} missing agentId or homeBaseUrl; skipping projection`,
    );
    return;
  }

  const successorHomeBaseUrl =
    event.eventType === AUTHORITY_EVENT_TYPES.SUCCESSOR_AUTHORITY_CLAIM
      ? (readString(payload, "successorHomeBaseUrl") ?? readString(payload, "newHomeBaseUrl"))
      : null;

  await persistAuthorityEvent({
    agentId,
    eventType: event.eventType as Parameters<typeof persistAuthorityEvent>[0]["eventType"],
    homeBaseUrl,
    homeAuthorityVersion: readInt(payload, "homeAuthorityVersion"),
    credentialVersion: readInt(payload, "credentialVersion"),
    successorHomeBaseUrl,
    signedBy,
    signedPayload: payload,
    signature: event.signature ?? null,
  });
}

/**
 * Imports federation events from a specific peer.
 *
 * Auth requirements:
 * - Requires valid federation authorization. Unauthenticated requests return `401`.
 *
 * Rate limiting:
 * - Applies per-peer throttling using the key format `federation-import:<fromPeerSlug>`.
 * - Limit/window values come from `RATE_LIMITS.FEDERATION_IMPORT`.
 * - Exceeded limits return `429 Too Many Requests`.
 *
 * Authority event projection:
 * - After the normal import pipeline accepts an event, the route projects any
 *   recognized authority event (`credential.updated`, `authority.revoke`,
 *   `successor.authority.claim`, `credential.tempwrite.from-global`) into the
 *   local guard cache so peer enforcement can see it on the next request.
 *
 * Error handling pattern:
 * - Malformed JSON or missing required fields return `400`.
 * - Import execution errors are normalized to JSON and returned as `400`.
 *
 * Security considerations:
 * - Rate limiting is scoped to peer identity to reduce abuse and protect ingestion capacity.
 * - Authority events only project after `importFederationEvents` has verified
 *   peer signature and replay-protection; no unsigned path populates the cache.
 *
 * @param {NextRequest} request - Incoming HTTP request with peer slug and event list.
 * @returns {Promise<NextResponse>} JSON response reporting imported count or error details.
 * @throws {Error} No uncaught throws are expected; handler normalizes known failures to HTTP responses.
 */
export async function POST(request: NextRequest) {
  // Security gate: only authenticated federation peers/services can push imports.
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json({ error: authorization.reason ?? "Authentication required" }, { status: STATUS_UNAUTHORIZED });
  }

  let body: ImportPayload;
  try {
    body = (await request.json()) as ImportPayload;
  } catch {
    // Reject malformed JSON early to keep downstream import logic strict.
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: STATUS_BAD_REQUEST });
  }

  if (!body.fromPeerSlug || !Array.isArray(body.events)) {
    // Business rule: import requests must identify a source peer and include an event batch.
    return NextResponse.json({ error: "fromPeerSlug and events are required" }, { status: STATUS_BAD_REQUEST });
  }

  // Abuse protection: throttle import throughput per source peer.
  const limiter = await rateLimit(
    `federation-import:${body.fromPeerSlug}`,
    RATE_LIMITS.FEDERATION_IMPORT.limit,
    RATE_LIMITS.FEDERATION_IMPORT.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please try again later." },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  // Scope import execution to the authenticated local node.
  const localNode = await ensureLocalNode(authorization.actorId);

  try {
    const result = await importFederationEvents({
      localNodeId: localNode.id,
      fromPeerSlug: body.fromPeerSlug,
      events: body.events,
    });

    // Project authority events into the guard cache.
    // `importFederationEvents` already verified peer signatures and replay
    // protection, so any event that survives to this point is trusted.
    // Rejected events have `rejections[].index` recorded; we skip those.
    const rejectedIndices = new Set<number>(
      Array.isArray(result.rejections) ? result.rejections.map((r) => r.index) : [],
    );
    for (let i = 0; i < body.events.length; i++) {
      if (rejectedIndices.has(i)) continue;
      const event = body.events[i];
      if (!isRecognizedAuthorityEventType(event.eventType)) continue;
      try {
        await projectAuthorityEvent(event, body.fromPeerSlug);
      } catch (projectionError) {
        // Projection failures must not break the import response — log and
        // continue. The import itself already succeeded.
        console.error(
          "[federation/events/import] Authority event projection failed:",
          projectionError instanceof Error ? projectionError.message : projectionError,
        );
      }
    }

    return NextResponse.json({ success: true, imported: result.imported });
  } catch (error) {
    // Normalize import-layer failures into client-visible, structured API errors.
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Import failed",
      },
      { status: STATUS_BAD_REQUEST }
    );
  }
}
