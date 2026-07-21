/**
 * Meeting-recording state helpers (pure).
 *
 * A Virtual Meeting event tracks its per-participant track recordings in
 * `resources.metadata.meetingRecordings` — one entry per started egress.
 * These helpers parse/patch that array without any IO.
 *
 * Unit-tested in src/lib/__tests__/meeting-recordings.test.ts.
 */

import {
  META_MEETING_RECORDINGS,
  RECORDING_STATUS,
  type RecordingStatus,
} from "./constants";

export interface MeetingRecordingEntry {
  egressId: string;
  trackSid: string;
  /** Authenticated agent id owning the recorded track. */
  identity: string;
  /** Display name at recording time (speaker label). */
  displayName: string;
  /** Object key in the recordings bucket. */
  fileKey: string;
  status: RecordingStatus;
  /** Epoch ms when the egress started. */
  startedAtMs: number;
  endedAtMs?: number;
  error?: string;
}

function isRecordingStatus(value: unknown): value is RecordingStatus {
  return (
    value === RECORDING_STATUS.RECORDING ||
    value === RECORDING_STATUS.COMPLETE ||
    value === RECORDING_STATUS.TRANSCRIBED ||
    value === RECORDING_STATUS.FAILED
  );
}

function sanitizeEntry(input: unknown): MeetingRecordingEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;

  const egressId =
    typeof record.egressId === "string" && record.egressId.trim()
      ? record.egressId.trim()
      : null;
  const trackSid =
    typeof record.trackSid === "string" && record.trackSid.trim()
      ? record.trackSid.trim()
      : null;
  const identity =
    typeof record.identity === "string" && record.identity.trim()
      ? record.identity.trim()
      : null;
  const fileKey =
    typeof record.fileKey === "string" && record.fileKey.trim()
      ? record.fileKey.trim()
      : null;
  const startedAtMs =
    typeof record.startedAtMs === "number" && Number.isFinite(record.startedAtMs)
      ? record.startedAtMs
      : null;

  if (!egressId || !trackSid || !identity || !fileKey || startedAtMs === null) {
    return null;
  }

  return {
    egressId,
    trackSid,
    identity,
    fileKey,
    startedAtMs,
    displayName:
      typeof record.displayName === "string" && record.displayName.trim()
        ? record.displayName.trim()
        : identity,
    status: isRecordingStatus(record.status)
      ? record.status
      : RECORDING_STATUS.RECORDING,
    endedAtMs:
      typeof record.endedAtMs === "number" && Number.isFinite(record.endedAtMs)
        ? record.endedAtMs
        : undefined,
    error:
      typeof record.error === "string" && record.error.trim()
        ? record.error.trim()
        : undefined,
  };
}

/** Reads the recordings array off event metadata; invalid entries dropped. */
export function parseMeetingRecordings(
  metadata: Record<string, unknown> | null | undefined,
): MeetingRecordingEntry[] {
  const raw = metadata?.[META_MEETING_RECORDINGS];
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeEntry)
    .filter((entry): entry is MeetingRecordingEntry => entry !== null);
}

/**
 * Returns a new list with `entry` inserted, or merged over an existing
 * entry with the same egressId (patch semantics — later fields win).
 */
export function upsertMeetingRecording(
  list: MeetingRecordingEntry[],
  entry: MeetingRecordingEntry,
): MeetingRecordingEntry[] {
  const index = list.findIndex((item) => item.egressId === entry.egressId);
  if (index === -1) return [...list, entry];
  const next = [...list];
  next[index] = { ...next[index], ...entry };
  return next;
}

/** Patch a single entry's fields by egressId; no-op when absent. */
export function patchMeetingRecording(
  list: MeetingRecordingEntry[],
  egressId: string,
  patch: Partial<MeetingRecordingEntry>,
): MeetingRecordingEntry[] {
  return list.map((item) =>
    item.egressId === egressId ? { ...item, ...patch } : item,
  );
}

/** True when a track for this trackSid is already being recorded. */
export function hasActiveRecordingForTrack(
  list: MeetingRecordingEntry[],
  trackSid: string,
): boolean {
  return list.some(
    (item) =>
      item.trackSid === trackSid &&
      item.status === RECORDING_STATUS.RECORDING,
  );
}
