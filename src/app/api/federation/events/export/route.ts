/**
 * Federation event export API route.
 *
 * Purpose:
 * - Queues and returns exportable federation events for the authenticated local node.
 *
 * Key exports:
 * - `POST`: Initiates export queueing and emits a batch of exportable events.
 *
 * Dependencies:
 * - `authorizeFederationRequest` for federation request authentication.
 * - `ensureLocalNode` for local node context.
 * - `queueExportEvents`, `listExportableEvents`, and `markEventsExported` for export workflow orchestration.
 * - HTTP status constants from `@/lib/http-status`.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import type { VisibilityLevel } from "@/db/schema";
import {
  ensureLocalNode,
  listExportableEvents,
  markEventsExported,
  queueExportEvents,
} from "@/lib/federation";
import { STATUS_UNAUTHORIZED } from "@/lib/http-status";

interface ExportPayload {
  targetNodeSlug?: string;
  visibilities?: VisibilityLevel[];
  scopeIds?: string[];
  limit?: number;
}

/**
 * Queues and exports federation events based on optional visibility/scope filters.
 *
 * Auth requirements:
 * - Requires valid federation authorization. Unauthorized requests return `401`.
 *
 * Rate limiting:
 * - No route-level limiter is enforced here; platform- or middleware-level controls
 *   should be used if request throttling is required.
 *
 * Error handling pattern:
 * - Invalid/missing JSON body is tolerated because the payload is optional.
 * - Authentication failures return explicit JSON errors and status codes.
 * - Service-level failures are allowed to propagate to global error handling.
 *
 * Business rules:
 * - After selecting exportable events, they are marked as exported in the same request flow.
 *
 * @param {NextRequest} request - Incoming HTTP request with optional export constraints.
 * @returns {Promise<NextResponse>} JSON response containing queue count and exported event payloads.
 * @throws {Error} Propagates unexpected federation service failures.
 * @example
 * ```ts
 * const req = new Request("https://example.com/api/federation/events/export", {
 *   method: "POST",
 *   body: JSON.stringify({ targetNodeSlug: "peer-a", limit: 100 }),
 * });
 * const response = await POST(req as NextRequest);
 * ```
 */
export async function POST(request: NextRequest) {
  // Security gate: export access is restricted to authenticated federation callers.
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json({ error: authorization.reason ?? "Authentication required" }, { status: STATUS_UNAUTHORIZED });
  }

  let body: ExportPayload = {};
  try {
    body = (await request.json()) as ExportPayload;
  } catch {
    // Business rule: an absent/invalid body falls back to default export behavior.
  }

  // All export operations are scoped to the authenticated local node.
  const localNode = await ensureLocalNode(authorization.actorId);

  // Queue creation and event listing are separate so export jobs can be tracked independently.
  const queued = await queueExportEvents({
    originNodeId: localNode.id,
    visibilities: body.visibilities,
    scopeIds: body.scopeIds,
    limit: body.limit,
  });

  const events = await listExportableEvents({
    originNodeId: localNode.id,
    targetNodeSlug: body.targetNodeSlug,
    limit: body.limit,
  });

  // Prevent re-export duplication by marking returned events as exported immediately.
  await markEventsExported(events.map((event) => event.id));

  return NextResponse.json({
    success: true,
    queued: queued.queued,
    exported: events.length,
    events: events.map((event) => ({
      id: event.id,
      entityType: event.entityType,
      eventType: event.eventType,
      visibility: event.visibility,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  });
}
