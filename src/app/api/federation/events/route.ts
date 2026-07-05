import { NextResponse } from "next/server";
import { db } from "@/db";
import { federationEvents } from "@/db/schema";
import { gt, and, eq } from "drizzle-orm";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { ensureLocalNode } from "@/lib/federation";
import { buildEnvelopeToSign, signPayload } from "@/lib/federation-crypto";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /api/federation/events?since={sequence}&limit={limit}
 *
 * Cursor-based event sync endpoint. Remote instances poll this
 * to get events they haven't processed yet. Requires peer auth,
 * session auth, or admin key.
 *
 * Only locally originated events are served. Imported peer events
 * are excluded — re-exporting them would echo another node's events
 * back to pullers, whose signature verification (against THIS node's
 * public key) would reject every one of them.
 */
export async function GET(request: Request) {
  try {
    const authResult = await authorizeFederationRequest(request);
    if (!authResult.authorized) {
      return NextResponse.json(
        { success: false, error: authResult.reason ?? "Unauthorized" },
        { status: 401 },
      );
    }
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10),
      MAX_LIMIT
    );
    const visibility = url.searchParams.get("visibility") || "public";

    const localNode = await ensureLocalNode();

    const events = await db
      .select()
      .from(federationEvents)
      .where(
        and(
          gt(federationEvents.sequence, since),
          eq(federationEvents.visibility, visibility as any),
          // Serve only events this node authored; imported peer events
          // must not be re-exported (they are signed by their origin,
          // not by us, and would fail the puller's signature check).
          eq(federationEvents.originNodeId, localNode.id)
        )
      )
      .orderBy(federationEvents.sequence)
      .limit(limit);

    const highWaterMark =
      events.length > 0
        ? Math.max(...events.map((e) => e.sequence || 0))
        : since;

    // Envelope signing (F6/#138): compute a full-envelope Ed25519 signature at
    // the wire boundary (not persisted) alongside the legacy payload signature.
    // `originNodeId` + `eventVersion` are added to the wire so the puller can
    // reconstruct the exact envelope for verification. Phase 1 is emit-only.
    const nodePrivateKey = localNode.privateKey;
    return NextResponse.json({
      success: true,
      events: events.map((e) => {
        const createdAt = e.createdAt?.toISOString();
        const envelopeSignature = nodePrivateKey
          ? signPayload(
              buildEnvelopeToSign({
                id: e.id,
                originNodeId: e.originNodeId,
                entityType: e.entityType,
                entityId: e.entityId,
                eventType: e.eventType,
                visibility: e.visibility,
                nonce: e.nonce,
                eventVersion: e.eventVersion,
                createdAt,
                payload: e.payload as Record<string, unknown> | null,
              }),
              nodePrivateKey,
            )
          : undefined;
        return {
          id: e.id,
          sequence: e.sequence,
          originNodeId: e.originNodeId,
          eventType: e.eventType,
          entityType: e.entityType,
          entityId: e.entityId,
          actorId: e.actorId,
          visibility: e.visibility,
          payload: e.payload,
          signature: e.signature,
          envelopeSignature,
          nonce: e.nonce,
          eventVersion: e.eventVersion,
          createdAt,
        };
      }),
      cursor: highWaterMark,
      hasMore: events.length === limit,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}
