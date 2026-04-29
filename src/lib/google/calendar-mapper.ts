/**
 * Mapping helpers between Rivr event resources and Google Calendar events.
 *
 * Purpose:
 * - Translate the Rivr event-resource shape (a `resources` row of type
 *   `'event'` with date/time/location in `metadata`) into a Google
 *   Calendar event body that `events.insert` / `events.patch` accept.
 * - Translate an inbound Google Calendar event into the partial resource
 *   patch the inbound sync code uses to create or update a Rivr event.
 *
 * Contract notes:
 * - We never copy Google's `id`/`etag`/`updated` into resource metadata —
 *   those live in the `resource_external_sync` sidecar.
 * - The Rivr metadata fields `date` (YYYY-MM-DD) and `time` (HH:MM, 24h)
 *   are the canonical source of when the event happens; we combine them
 *   into an ISO timestamp at map-out time.
 * - We do not invent a duration on the Rivr side — `venueStartTime` /
 *   `venueEndTime` (when present) are preferred for `start`/`end`. When
 *   only `date`+`time` are available we set a one-hour default end so
 *   Google has a valid window. The duration constant is named below.
 */

const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

/** Minimal Rivr event-resource shape consumed by the mapper. */
export interface RivrEventResourceLike {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
}

/** Patch body the inbound importer uses to upsert a Rivr event resource. */
export interface RivrEventResourcePatch {
  name: string;
  description: string;
  metadata: {
    entityType: 'event';
    resourceKind: 'event';
    date: string;
    time: string;
    location: string;
    eventType: 'in-person' | 'online';
    venueStartTime: string | null;
    venueEndTime: string | null;
    timezone: string | null;
    /** Marks the resource as having been imported from Google. */
    importedFrom: 'google_calendar';
  };
}

/** Subset of the Google event body we produce on outbound writes. */
export interface OutboundGoogleEventBody {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
}

import type { GoogleCalendarEvent } from './calendar';

// ---------------------------------------------------------------------------
// Rivr -> Google
// ---------------------------------------------------------------------------

/**
 * Build a Google Calendar event body from a Rivr event resource row.
 *
 * Throws when the resource is missing the minimum metadata needed to
 * produce a valid Google event window. The caller (sync engine) treats
 * such cases as a no-op and logs them — outbound sync is best-effort and
 * must never block resource creation.
 */
export function resourceToGoogleEvent(
  resource: RivrEventResourceLike,
): OutboundGoogleEventBody {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  const date = typeof metadata.date === 'string' ? metadata.date : null;
  const time = typeof metadata.time === 'string' ? metadata.time : null;
  if (!date || !time) {
    throw new Error(
      'resourceToGoogleEvent: resource is missing metadata.date or metadata.time',
    );
  }

  const timezone =
    typeof metadata.timezone === 'string' && metadata.timezone.length > 0
      ? metadata.timezone
      : undefined;
  const venueStart =
    typeof metadata.venueStartTime === 'string' && metadata.venueStartTime
      ? metadata.venueStartTime
      : null;
  const venueEnd =
    typeof metadata.venueEndTime === 'string' && metadata.venueEndTime
      ? metadata.venueEndTime
      : null;

  // Prefer explicit venue start/end when present; otherwise build a one-hour
  // window from date+time so Google has a valid `end`.
  const startIso = venueStart ?? `${date}T${time}:00`;
  const endIso = venueEnd ?? deriveDefaultEndIso(date, time);

  const location =
    typeof metadata.location === 'string' && metadata.location.length > 0
      ? metadata.location
      : undefined;

  return {
    summary: resource.name,
    description: resource.description ?? undefined,
    location,
    start: { dateTime: startIso, timeZone: timezone },
    end: { dateTime: endIso, timeZone: timezone },
  };
}

function deriveDefaultEndIso(date: string, time: string): string {
  const start = new Date(`${date}T${time}:00`);
  if (Number.isNaN(start.getTime())) {
    // Fall back to a literal one-hour bump on malformed input — Google
    // will still validate the `end` shape, and outbound errors are caught
    // by the caller as best-effort no-ops.
    return `${date}T${time}:00`;
  }
  return new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Google -> Rivr
// ---------------------------------------------------------------------------

/**
 * Translate an inbound Google Calendar event into a partial Rivr event
 * resource patch suitable for upsert by the inbound sync code.
 *
 * Returns `null` when the Google event is too sparse to render as a
 * Rivr event (e.g. missing both `start.dateTime` and `start.date`).
 */
export function googleEventToResourcePatch(
  googleEvent: GoogleCalendarEvent,
): RivrEventResourcePatch | null {
  const start = googleEvent.start;
  if (!start) return null;

  const summary =
    typeof googleEvent.summary === 'string' && googleEvent.summary.trim().length
      ? googleEvent.summary.trim()
      : '(Untitled event)';
  const description =
    typeof googleEvent.description === 'string' ? googleEvent.description : '';
  const location =
    typeof googleEvent.location === 'string' ? googleEvent.location : '';
  const timezone =
    typeof start.timeZone === 'string' && start.timeZone.length > 0
      ? start.timeZone
      : null;

  let date: string;
  let time: string;
  if (typeof start.dateTime === 'string' && start.dateTime.length > 0) {
    const parsed = new Date(start.dateTime);
    if (Number.isNaN(parsed.getTime())) return null;
    date = parsed.toISOString().slice(0, 10);
    time = parsed.toISOString().slice(11, 16);
  } else if (typeof start.date === 'string' && start.date.length > 0) {
    date = start.date;
    time = '00:00';
  } else {
    return null;
  }

  const venueStartTime =
    typeof start.dateTime === 'string' ? start.dateTime : null;
  const venueEndTime =
    typeof googleEvent.end?.dateTime === 'string'
      ? googleEvent.end.dateTime
      : null;

  return {
    name: summary,
    description,
    metadata: {
      entityType: 'event',
      resourceKind: 'event',
      date,
      time,
      location,
      // Google does not natively split in-person vs online; default to
      // in-person and let the user adjust in Rivr if needed.
      eventType: 'in-person',
      venueStartTime,
      venueEndTime,
      timezone,
      importedFrom: 'google_calendar',
    },
  };
}
