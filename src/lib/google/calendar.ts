/**
 * Thin Google Calendar v3 REST client for the per-group Workspace
 * connection (PR2 — two-way sync).
 *
 * Purpose:
 * - Encapsulate every HTTP call we make against Google Calendar so the
 *   sync orchestration code never holds raw URLs, headers, or
 *   provider-specific JSON shapes.
 * - Reuse the existing token refresh path
 *   ({@link getFreshGoogleAccessToken}); never duplicate the OAuth state
 *   machine or token cache.
 *
 * Key exports:
 * - {@link listEvents}    — incremental listing (sync token preferred,
 *                           updatedMin fallback).
 * - {@link insertEvent}   — create a Google event for a Rivr resource.
 * - {@link patchEvent}    — patch with `If-Match` for optimistic
 *                           concurrency.
 * - {@link deleteEvent}   — delete a Google event for a Rivr resource.
 * - {@link resolveCalendarId} — pick the right calendar id for a
 *                               connection.
 * - {@link GoogleCalendarError} — typed error with stable codes.
 *
 * Error model:
 * - Every helper throws a {@link GoogleCalendarError} when Google rejects
 *   the request. The `code` is one of {@link GOOGLE_CALENDAR_ERROR_CODES}
 *   so call sites can branch deterministically — e.g. `precondition` for
 *   412 etag mismatches that drive last-write-wins, `auth` for 401, etc.
 *
 * Out of scope:
 * - Mapping between Rivr resource shape and Google event shape. That
 *   lives in `./calendar-mapper.ts`.
 * - Persistence and echo suppression. That lives in
 *   `./calendar-sync.ts`.
 */

import {
  GOOGLE_CALENDAR_API_BASE,
  GOOGLE_CALENDAR_DEFAULT_ID,
} from './constants';
import { getFreshGoogleAccessToken } from './token';

/** Stable error codes for Google Calendar API failures. */
export const GOOGLE_CALENDAR_ERROR_CODES = {
  AUTH: 'auth',
  NOT_FOUND: 'not_found',
  PRECONDITION: 'precondition',
  RATE_LIMIT: 'rate_limit',
  UNKNOWN: 'unknown',
} as const;

export type GoogleCalendarErrorCode =
  (typeof GOOGLE_CALENDAR_ERROR_CODES)[keyof typeof GOOGLE_CALENDAR_ERROR_CODES];

/** Typed error carrying a stable code so call sites can branch deterministically. */
export class GoogleCalendarError extends Error {
  public readonly code: GoogleCalendarErrorCode;
  public readonly status: number;

  constructor(code: GoogleCalendarErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'GoogleCalendarError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of the Google Calendar event resource that we read or write.
 *
 * Other fields are passed through opaquely on inbound import via the
 * mapper; we only type the ones the sync paths must reason about.
 */
export interface GoogleCalendarEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  // Pass-through fields we do not explicitly map.
  [key: string]: unknown;
}

/**
 * Google Calendar's start/end shape: either an all-day `date` or a
 * timezone-qualified `dateTime`.
 */
export interface GoogleCalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/**
 * Patch body when creating or updating a Google Calendar event. We accept a
 * minimal typed shape and pass extra fields through.
 */
export type GoogleCalendarEventPatch = Partial<GoogleCalendarEvent>;

export interface ListEventsResult {
  events: GoogleCalendarEvent[];
  nextSyncToken?: string;
  nextPageToken?: string;
}

export interface ListEventsArgs {
  groupId: string;
  calendarId: string;
  syncToken?: string;
  updatedMin?: string;
  pageToken?: string;
  /** Caps the number of events returned per page; Google clamps to 250. */
  pageSize?: number;
}

export interface InsertEventArgs {
  groupId: string;
  calendarId: string;
  event: GoogleCalendarEventPatch;
}

export interface PatchEventArgs {
  groupId: string;
  calendarId: string;
  eventId: string;
  event: GoogleCalendarEventPatch;
  /** Etag from the previous read; sent as `If-Match` for OCC. */
  etag?: string | null;
}

export interface DeleteEventArgs {
  groupId: string;
  calendarId: string;
  eventId: string;
}

/** Subset of `groupConnections.config` that affects calendar selection. */
export interface ConnectionLikeForCalendar {
  config?: { calendarId?: string } | null;
}

/**
 * Resolve the effective calendar id for a connection.
 *
 * When `connection.config.calendarId` is set and non-empty, use it.
 * Otherwise default to {@link GOOGLE_CALENDAR_DEFAULT_ID} ('primary').
 */
export function resolveCalendarId(
  connection: ConnectionLikeForCalendar | null | undefined,
): string {
  const configured = connection?.config?.calendarId?.trim();
  return configured && configured.length > 0
    ? configured
    : GOOGLE_CALENDAR_DEFAULT_ID;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BODY_PREVIEW = 300;

function eventsBaseUrl(calendarId: string): string {
  return `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(
    calendarId,
  )}/events`;
}

function classifyStatus(status: number): GoogleCalendarErrorCode {
  if (status === 401 || status === 403) return GOOGLE_CALENDAR_ERROR_CODES.AUTH;
  if (status === 404 || status === 410)
    return GOOGLE_CALENDAR_ERROR_CODES.NOT_FOUND;
  if (status === 412) return GOOGLE_CALENDAR_ERROR_CODES.PRECONDITION;
  if (status === 429) return GOOGLE_CALENDAR_ERROR_CODES.RATE_LIMIT;
  return GOOGLE_CALENDAR_ERROR_CODES.UNKNOWN;
}

async function buildAuthHeaders(
  groupId: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const token = await getFreshGoogleAccessToken(groupId);
  return {
    Authorization: `Bearer ${token.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

async function throwIfNotOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  throw new GoogleCalendarError(
    classifyStatus(response.status),
    response.status,
    `Google Calendar ${action} failed (HTTP ${response.status}): ${body.slice(
      0,
      MAX_RESPONSE_BODY_PREVIEW,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Incremental list of events on a calendar.
 *
 * Prefer `syncToken` (Google's incremental cursor). Fall back to
 * `updatedMin` for the first poll or after a `410 Gone` invalidates the
 * stored token. When Google returns a 410 the caller should clear the
 * stored sync token and retry with `updatedMin`.
 */
export async function listEvents(args: ListEventsArgs): Promise<ListEventsResult> {
  const params = new URLSearchParams();
  params.set('singleEvents', 'true');
  params.set('showDeleted', 'true');
  if (args.pageSize) params.set('maxResults', String(args.pageSize));
  if (args.syncToken) {
    params.set('syncToken', args.syncToken);
  } else if (args.updatedMin) {
    params.set('updatedMin', args.updatedMin);
    params.set('orderBy', 'updated');
  }
  if (args.pageToken) params.set('pageToken', args.pageToken);

  const headers = await buildAuthHeaders(args.groupId);
  const response = await fetch(
    `${eventsBaseUrl(args.calendarId)}?${params.toString()}`,
    { method: 'GET', headers },
  );
  await throwIfNotOk(response, 'events.list');

  const data = (await response.json()) as {
    items?: GoogleCalendarEvent[];
    nextSyncToken?: string;
    nextPageToken?: string;
  };

  return {
    events: Array.isArray(data.items) ? data.items : [],
    nextSyncToken: data.nextSyncToken,
    nextPageToken: data.nextPageToken,
  };
}

/** Create a Google Calendar event from a Rivr-shaped patch body. */
export async function insertEvent(
  args: InsertEventArgs,
): Promise<GoogleCalendarEvent> {
  const headers = await buildAuthHeaders(args.groupId);
  const response = await fetch(eventsBaseUrl(args.calendarId), {
    method: 'POST',
    headers,
    body: JSON.stringify(args.event),
  });
  await throwIfNotOk(response, 'events.insert');
  return (await response.json()) as GoogleCalendarEvent;
}

/**
 * Patch a Google Calendar event with optimistic concurrency.
 *
 * When `etag` is provided we send `If-Match: <etag>` so Google returns
 * 412 Precondition Failed if the underlying event has changed since we
 * read it. Callers translate 412 into a last-write-wins resolution.
 */
export async function patchEvent(
  args: PatchEventArgs,
): Promise<GoogleCalendarEvent> {
  const extraHeaders: Record<string, string> = {};
  if (args.etag) extraHeaders['If-Match'] = args.etag;
  const headers = await buildAuthHeaders(args.groupId, extraHeaders);
  const response = await fetch(
    `${eventsBaseUrl(args.calendarId)}/${encodeURIComponent(args.eventId)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(args.event),
    },
  );
  await throwIfNotOk(response, 'events.patch');
  return (await response.json()) as GoogleCalendarEvent;
}

/**
 * Delete a Google Calendar event. Treats 404/410 as success since the
 * caller's intent is "make sure this is gone."
 */
export async function deleteEvent(args: DeleteEventArgs): Promise<void> {
  const headers = await buildAuthHeaders(args.groupId);
  const response = await fetch(
    `${eventsBaseUrl(args.calendarId)}/${encodeURIComponent(args.eventId)}`,
    { method: 'DELETE', headers },
  );
  if (response.ok) return;
  if (response.status === 404 || response.status === 410) return;
  await throwIfNotOk(response, 'events.delete');
}
