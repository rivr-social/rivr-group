/**
 * Lists the Google calendars visible to a group's linked Workspace account.
 *
 * Auth: caller must be signed in AND admin/moderator of the target group —
 * the same guard idiom as the sibling `connect` route.
 *
 * Behavior:
 * - Resolves a fresh access token via the existing token helper
 *   ({@link getFreshGoogleAccessToken}) — never duplicates token handling.
 * - Calls Google Calendar v3 `users/me/calendarList` and maps each entry to
 *   `{ id, summary, primary? }` only.
 * - Degrades gracefully: a missing connection or any token/provider failure
 *   returns HTTP 200 with `{ calendars: [], error: "not_connected" }` so the
 *   Connections UI can fall back to the manual calendar-id input.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isGroupAdmin } from '@/app/actions/group-admin';
import { GOOGLE_CALENDAR_API_BASE } from '@/lib/google/constants';
import {
  getFreshGoogleAccessToken,
  GoogleTokenError,
} from '@/lib/google/token';

export const dynamic = 'force-dynamic';

/** Stable error code the client branches on when no usable connection exists. */
const CALENDAR_LIST_ERROR_NOT_CONNECTED = 'not_connected' as const;

/** Google Calendar v3 calendarList endpoint for the authorized account. */
const GOOGLE_CALENDAR_LIST_URL =
  `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList` as const;

/** Single calendar entry surfaced to the Connections UI picker. */
interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
}

/** Degraded-but-successful response when no calendar list is available. */
function notConnectedResponse(): NextResponse {
  return NextResponse.json({
    calendars: [] as CalendarListEntry[],
    error: CALENDAR_LIST_ERROR_NOT_CONNECTED,
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await context.params;
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const isAdmin = await isGroupAdmin(session.user.id, groupId);
  if (!isAdmin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let accessToken: string;
  try {
    const token = await getFreshGoogleAccessToken(groupId);
    accessToken = token.accessToken;
  } catch (error) {
    if (error instanceof GoogleTokenError) {
      // Not linked / expired without refresh / refresh failed — all degrade
      // to the manual calendar-id input on the client.
      return notConnectedResponse();
    }
    throw error;
  }

  const response = await fetch(GOOGLE_CALENDAR_LIST_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return notConnectedResponse();
  }

  const data = (await response.json()) as {
    items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
  };

  const calendars: CalendarListEntry[] = (
    Array.isArray(data.items) ? data.items : []
  )
    .filter(
      (item): item is { id: string; summary?: string; primary?: boolean } =>
        typeof item.id === 'string' && item.id.length > 0,
    )
    .map((item) => ({
      id: item.id,
      summary: item.summary ?? item.id,
      ...(item.primary ? { primary: true } : {}),
    }));

  return NextResponse.json({ calendars });
}
