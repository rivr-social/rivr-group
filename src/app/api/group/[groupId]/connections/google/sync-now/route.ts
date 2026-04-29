/**
 * Manual "Sync now" trigger for a single group's Google Calendar
 * connection (PR2 slice 4).
 *
 * Auth: caller must be signed in AND admin/moderator of the target
 * group. Unlike the cron route at `/api/cron/google-calendar-sync`,
 * this endpoint does NOT accept a shared secret — it is gated by the
 * same `isGroupAdmin` check the rest of the Connections settings page
 * uses, so a group admin can drive their own connection on demand
 * without needing the cron credential.
 *
 * Behavior:
 * - Loads the group's Google Workspace connection.
 * - 404 if no connection exists or `calendarSyncEnabled` is off — the
 *   UI uses the toggle, so a click on "Sync now" with the toggle off
 *   is a user error worth surfacing.
 * - Delegates to `runInboundSyncForConnection` so the manual path and
 *   the cron path apply the same echo suppression, last-write-wins,
 *   and sidecar persistence rules.
 *
 * Error model:
 * - Stable codes returned in the JSON body so the client form renders
 *   them through the existing `ERROR_MESSAGES` mapping without leaking
 *   provider error bodies.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { isGroupAdmin } from '@/app/actions/group-admin';
import { db } from '@/db';
import { groupConnections } from '@/db/schema';
import { GOOGLE_WORKSPACE_PROVIDER } from '@/lib/google/constants';
import { runInboundSyncForConnection } from '@/app/api/cron/google-calendar-sync/route';

export const dynamic = 'force-dynamic';

/** Stable error codes for the manual sync trigger. */
export const SYNC_NOW_ERRORS = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_LINKED: 'not_linked',
  DISABLED: 'disabled',
  PROVIDER_ERROR: 'provider_error',
} as const;

export type SyncNowErrorCode =
  (typeof SYNC_NOW_ERRORS)[keyof typeof SYNC_NOW_ERRORS];

export async function POST(
  _request: Request,
  context: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  const { groupId } = await context.params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: SYNC_NOW_ERRORS.UNAUTHENTICATED },
      { status: 401 },
    );
  }

  const admin = await isGroupAdmin(session.user.id, groupId);
  if (!admin) {
    return NextResponse.json(
      { error: SYNC_NOW_ERRORS.FORBIDDEN },
      { status: 403 },
    );
  }

  const [connection] = await db
    .select()
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  if (!connection) {
    return NextResponse.json(
      { error: SYNC_NOW_ERRORS.NOT_LINKED },
      { status: 404 },
    );
  }

  if (!connection.config?.calendarSyncEnabled) {
    return NextResponse.json(
      { error: SYNC_NOW_ERRORS.DISABLED },
      { status: 409 },
    );
  }

  try {
    const result = await runInboundSyncForConnection(connection);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[google-calendar-sync] manual sync failed for group ${groupId}: ${message}`,
    );
    return NextResponse.json(
      { error: SYNC_NOW_ERRORS.PROVIDER_ERROR, message },
      { status: 502 },
    );
  }
}
