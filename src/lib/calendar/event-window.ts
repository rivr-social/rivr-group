/**
 * Canonical event date/time contract.
 *
 * One source of truth for turning an event's `metadata.date` / `metadata.time`
 * (plus optional `endDate` / `endTime` / `durationMinutes`) into ISO start/end
 * timestamps. Every surface that needs an event's schedule — the graph adapter
 * that feeds the calendar and event-detail views, and the ICS / Add-to-Calendar
 * export — MUST resolve through these helpers so a single event renders the same
 * window everywhere. Historically the ICS route re-implemented this with a
 * different default time (09:00 vs 00:00), a different default duration (60 vs
 * 120 min), and ignored `endDate`/`endTime`, producing exports that disagreed
 * with the on-screen calendar (issue #106).
 *
 * Convention: `metadata.date`/`time` are interpreted as wall-clock local time of
 * the runtime, then serialized to ISO (UTC). Downstream display converts back.
 */

/** Default span (minutes) applied when an event has a real start but no explicit end. */
export const DEFAULT_EVENT_DURATION_MINUTES = 120;

const TIME_PATTERN = /^\d{2}:\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds an ISO start timestamp from `metadata.date` (`YYYY-MM-DD`) and
 * `metadata.time` (`HH:MM`). Returns undefined when `date` is absent; callers
 * fall back to `meta.startDate` or the agent's `createdAt`. A missing/malformed
 * `time` defaults to midnight (`00:00`).
 */
export function composeEventStartIso(meta: Record<string, unknown>): string | undefined {
  const date = typeof meta.date === "string" ? meta.date : undefined;
  if (!date) return undefined;
  const time = typeof meta.time === "string" && TIME_PATTERN.test(meta.time) ? meta.time : "00:00";
  // Treat the date+time as local; downstream consumers convert to UTC for display.
  const composed = new Date(`${date}T${time}:00`);
  return Number.isNaN(composed.getTime()) ? undefined : composed.toISOString();
}

/**
 * Builds an ISO end timestamp.
 *
 * Resolution order:
 * 1. If `metadata.endDate` (YYYY-MM-DD) and `metadata.endTime` (HH:MM) are both
 *    present, compose them.
 * 2. Else if only `metadata.endTime` is set, fall back to combining it with
 *    `metadata.date` (same-day end).
 * 3. Else if `metadata.durationMinutes` is a positive number, add it to start.
 * 4. Else if start info (`metadata.date` + `metadata.time`) is present, default
 *    the end to start + DEFAULT_EVENT_DURATION_MINUTES so the UI doesn't render
 *    midnight ("12:00 AM").
 * 5. Otherwise return undefined and let the caller render a single time.
 */
export function composeEventEndIso(meta: Record<string, unknown>, startIso: string): string | undefined {
  const endDate =
    typeof meta.endDate === "string" && DATE_PATTERN.test(meta.endDate) ? meta.endDate : undefined;
  const endTime =
    typeof meta.endTime === "string" && TIME_PATTERN.test(meta.endTime) ? meta.endTime : undefined;
  const date = typeof meta.date === "string" ? meta.date : undefined;

  if (endDate && endTime) {
    const composed = new Date(`${endDate}T${endTime}:00`);
    if (!Number.isNaN(composed.getTime())) return composed.toISOString();
  }
  if (date && endTime) {
    const composed = new Date(`${date}T${endTime}:00`);
    if (!Number.isNaN(composed.getTime())) return composed.toISOString();
  }

  const durationMinutes =
    typeof meta.durationMinutes === "number" && Number.isFinite(meta.durationMinutes) && meta.durationMinutes > 0
      ? meta.durationMinutes
      : undefined;
  if (durationMinutes) {
    const start = new Date(startIso);
    if (!Number.isNaN(start.getTime())) {
      return new Date(start.getTime() + durationMinutes * 60_000).toISOString();
    }
  }

  // Default: if we have a real start (date+time), assume a fixed-length window.
  const time = typeof meta.time === "string" ? meta.time : undefined;
  if (date && time) {
    const start = new Date(startIso);
    if (!Number.isNaN(start.getTime())) {
      return new Date(start.getTime() + DEFAULT_EVENT_DURATION_MINUTES * 60_000).toISOString();
    }
  }

  return undefined;
}

/**
 * Resolves a concrete start/end `Date` pair for export surfaces (ICS, deep
 * links). Returns nulls when the event has no usable start. Uses the same
 * contract as {@link composeEventStartIso} / {@link composeEventEndIso}, so the
 * exported window matches the calendar and event-detail views exactly.
 */
export function resolveEventWindow(meta: Record<string, unknown>): {
  start: Date | null;
  end: Date | null;
} {
  const startIso = composeEventStartIso(meta);
  if (!startIso) return { start: null, end: null };
  const endIso = composeEventEndIso(meta, startIso) ?? startIso;
  return { start: new Date(startIso), end: new Date(endIso) };
}
