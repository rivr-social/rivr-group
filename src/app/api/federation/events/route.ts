import { NextResponse } from "next/server";
import { db } from "@/db";
import { federationEvents } from "@/db/schema";
import { gt, and, eq } from "drizzle-orm";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /api/federation/events?since={sequence}&limit={limit}
 *
 * Cursor-based event sync endpoint. Remote instances poll this
 * to get events they haven't processed yet.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10),
      MAX_LIMIT
    );
    const visibility = url.searchParams.get("visibility") || "public";

    const events = await db
      .select()
      .from(federationEvents)
      .where(
        and(
          gt(federationEvents.sequence, since),
          eq(federationEvents.visibility, visibility as any)
        )
      )
      .orderBy(federationEvents.sequence)
      .limit(limit);

    const highWaterMark =
      events.length > 0
        ? Math.max(...events.map((e) => e.sequence || 0))
        : since;

    return NextResponse.json({
      success: true,
      events: events.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        eventType: e.eventType,
        entityType: e.entityType,
        entityId: e.entityId,
        actorId: e.actorId,
        visibility: e.visibility,
        payload: e.payload,
        signature: e.signature,
        nonce: e.nonce,
        createdAt: e.createdAt?.toISOString(),
      })),
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
