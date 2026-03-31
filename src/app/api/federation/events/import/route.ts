/**
 * Federation event import API route.
 *
 * Purpose:
 * - Ingests event batches from a peer into the authenticated local node context.
 *
 * Key exports:
 * - `POST`: Validates payload, enforces per-peer rate limits, and imports events.
 *
 * Dependencies:
 * - `authorizeFederationRequest` for federation request authentication.
 * - `rateLimit` and `RATE_LIMITS` for abuse protection on import workloads.
 * - `ensureLocalNode` and `importFederationEvents` for scoped import execution.
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
 * Error handling pattern:
 * - Malformed JSON or missing required fields return `400`.
 * - Import execution errors are normalized to JSON and returned as `400`.
 *
 * Security considerations:
 * - Rate limiting is scoped to peer identity to reduce abuse and protect ingestion capacity.
 *
 * @param {NextRequest} request - Incoming HTTP request with peer slug and event list.
 * @returns {Promise<NextResponse>} JSON response reporting imported count or error details.
 * @throws {Error} No uncaught throws are expected; handler normalizes known failures to HTTP responses.
 * @example
 * ```ts
 * const req = new Request("https://example.com/api/federation/events/import", {
 *   method: "POST",
 *   body: JSON.stringify({
 *     fromPeerSlug: "peer-a",
 *     events: [{ entityType: "record", eventType: "created", visibility: "private", payload: {} }],
 *   }),
 * });
 * const response = await POST(req as NextRequest);
 * ```
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
