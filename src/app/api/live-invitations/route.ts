/**
 * GET /api/live-invitations
 *
 * Returns active live invitation posts (created within the last hour) with
 * their geolocation. Results are scoped by locale and/or group membership.
 *
 * Query params:
 * - localeId?: string — filter to posts tagged with this locale
 * - groupId?: string — filter to posts in this group (requires membership)
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const url = new URL(request.url);
  const localeId = url.searchParams.get("localeId");
  const groupId = url.searchParams.get("groupId");
  const nowIso = new Date().toISOString();

  try {
    const membershipRows = await db.execute(sql`
      SELECT object_id
      FROM ledger
      WHERE subject_id = ${userId}::uuid
        AND verb = 'join'
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
    `);
    const activeGroupIds = new Set(
      (membershipRows as unknown as Array<{ object_id: string | null }>)
        .map((row) => row.object_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );

    // If groupId specified, verify active membership first.
    if (groupId) {
      if (!activeGroupIds.has(groupId)) {
        return NextResponse.json(
          { error: "You are not a member of this group" },
          { status: STATUS_FORBIDDEN },
        );
      }
    }

    // Query live invitation posts with location data
    const result = await db.execute(sql`
      SELECT
        r.id,
        r.content,
        r.created_at,
        r.metadata,
        ST_X(r.location::geometry) as lng,
        ST_Y(r.location::geometry) as lat,
        a.id as author_id,
        a.name as author_name,
        (a.metadata->>'avatar')::text as author_avatar
      FROM resources r
      JOIN agents a ON a.id = r.owner_id
      WHERE r.type = 'post'
        AND r.location IS NOT NULL
        AND (r.metadata->>'isLiveInvitation')::boolean = true
        AND COALESCE((r.metadata->>'liveExpiresAt')::timestamptz, r.created_at + interval '1 hour') > ${nowIso}::timestamptz
        ${localeId ? sql`AND r.tags @> ARRAY[${localeId}]::text[]` : sql``}
        ${groupId ? sql`AND r.tags @> ARRAY[${groupId}]::text[]` : sql``}
      ORDER BY r.created_at DESC
      LIMIT 100
    `);

    const rows = result as unknown as Record<string, unknown>[];
    const invitations = rows
      .filter((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const scopedUserIds = asStringArray(meta.scopedUserIds);
        if (scopedUserIds.length > 0 && !scopedUserIds.includes(userId)) {
          return false;
        }

        const scopedGroupIds = asStringArray(meta.scopedGroupIds);
        if (scopedGroupIds.length > 0 && !scopedGroupIds.some((id) => activeGroupIds.has(id))) {
          return false;
        }

        return true;
      })
      .map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          id: row.id as string,
          content: row.content as string,
          createdAt: row.created_at as string,
          lat: row.lat as number,
          lng: row.lng as number,
          expiresAt: (meta.liveExpiresAt as string) ?? null,
          author: {
            id: row.author_id as string,
            name: row.author_name as string,
            avatar: (row.author_avatar as string) ?? "/placeholder-user.jpg",
          },
        };
      });

    return NextResponse.json({ invitations }, { status: STATUS_OK });
  } catch (error) {
    console.error("[live-invitations] Query error:", error);
    return NextResponse.json(
      { error: "Failed to fetch live invitations" },
      { status: 500 },
    );
  }
}
