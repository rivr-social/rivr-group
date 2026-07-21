/**
 * Pure event-time-window math for Virtual Meetings.
 *
 * Events store their schedule in metadata as either explicit ISO
 * `startDate`/`endDate` or the create-flow's `date` + `time` strings.
 * The join window opens shortly before start and closes a grace period
 * after end. Unit-tested in src/lib/__tests__/event-window.test.ts.
 */

import { JOIN_WINDOW_BEFORE_MS, JOIN_WINDOW_AFTER_MS } from "./constants";

const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;

export interface EventWindow {
  startMs: number;
  endMs: number;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Resolves the event's scheduled window from its metadata; null if unknown. */
export function resolveEventWindow(
  metadata: Record<string, unknown> | null | undefined,
): EventWindow | null {
  if (!metadata) return null;

  let startMs = parseIso(metadata.startDate);
  if (startMs === null) {
    const date = typeof metadata.date === "string" ? metadata.date.trim() : "";
    if (date) {
      const time =
        typeof metadata.time === "string" && metadata.time.trim()
          ? metadata.time.trim()
          : "00:00";
      startMs = parseIso(`${date}T${time}`);
    }
  }
  if (startMs === null) return null;

  const endMs = parseIso(metadata.endDate) ?? startMs + DEFAULT_EVENT_DURATION_MS;
  return { startMs, endMs: Math.max(endMs, startMs) };
}

/**
 * Whether the meeting is joinable at `nowMs`. Unknown schedules fail OPEN
 * (the membership gate still applies; a meeting nobody scheduled precisely
 * shouldn't be unjoinable).
 */
export function isWithinJoinWindow(
  metadata: Record<string, unknown> | null | undefined,
  nowMs: number,
): boolean {
  const window = resolveEventWindow(metadata);
  if (!window) return true;
  return (
    nowMs >= window.startMs - JOIN_WINDOW_BEFORE_MS &&
    nowMs <= window.endMs + JOIN_WINDOW_AFTER_MS
  );
}
