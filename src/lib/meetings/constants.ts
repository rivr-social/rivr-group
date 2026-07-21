/**
 * Constants for the Virtual Meeting subsystem (LiveKit).
 *
 * Ported from the person app's meetings lane and extended for the group
 * app's Virtual Meeting events: per-participant track recording and
 * identity-correlated transcripts.
 */

// ---------------------------------------------------------------------------
// Environment variable keys
// ---------------------------------------------------------------------------

export const ENV_LIVEKIT_URL = "LIVEKIT_URL";
export const ENV_LIVEKIT_WS_URL = "LIVEKIT_WS_URL";
export const ENV_LIVEKIT_API_KEY = "LIVEKIT_API_KEY";
export const ENV_LIVEKIT_API_SECRET = "LIVEKIT_API_SECRET";

/** S3-compatible storage for meeting recordings (egress output target). */
export const ENV_RECORDINGS_S3_ENDPOINT = "MEETING_RECORDINGS_S3_ENDPOINT";
export const ENV_RECORDINGS_S3_ACCESS_KEY = "MEETING_RECORDINGS_S3_ACCESS_KEY";
export const ENV_RECORDINGS_S3_SECRET_KEY = "MEETING_RECORDINGS_S3_SECRET_KEY";
export const ENV_RECORDINGS_S3_BUCKET = "MEETING_RECORDINGS_S3_BUCKET";
export const ENV_RECORDINGS_S3_REGION = "MEETING_RECORDINGS_S3_REGION";

// ---------------------------------------------------------------------------
// Room configuration defaults
// ---------------------------------------------------------------------------

/** Maximum number of concurrent participants per room. */
export const DEFAULT_MAX_PARTICIPANTS = 100;

/** Token time-to-live in seconds (6 hours). */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** Room empty timeout in seconds (10 minutes). */
export const ROOM_EMPTY_TIMEOUT_SECONDS = 10 * 60;

/** Participants may join this long before the event's start time. */
export const JOIN_WINDOW_BEFORE_MS = 15 * 60 * 1000;

/** Participants may join this long after the event's end time. */
export const JOIN_WINDOW_AFTER_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Room naming
// ---------------------------------------------------------------------------

export const ROOM_PREFIX_EVENT = "evt";

/** Deterministic room name for an event's virtual meeting. */
export function eventRoomName(eventId: string): string {
  return `${ROOM_PREFIX_EVENT}-${eventId}`;
}

/** Reverse of {@link eventRoomName}; null when not an event room. */
export function eventIdFromRoomName(roomName: string): string | null {
  const prefix = `${ROOM_PREFIX_EVENT}-`;
  if (!roomName.startsWith(prefix)) return null;
  const id = roomName.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Meeting kinds / statuses
// ---------------------------------------------------------------------------

/** metadata.meetingKind value marking an event as a hosted Virtual Meeting. */
export const MEETING_KIND_VIRTUAL = "virtual-meeting";

export const MEETING_STATUS = {
  ACTIVE: "active",
  ENDED: "ended",
  SCHEDULED: "scheduled",
} as const;

export type MeetingStatus = (typeof MEETING_STATUS)[keyof typeof MEETING_STATUS];

/** Per-participant recording lifecycle. */
export const RECORDING_STATUS = {
  RECORDING: "recording",
  COMPLETE: "complete",
  TRANSCRIBED: "transcribed",
  FAILED: "failed",
} as const;

export type RecordingStatus =
  (typeof RECORDING_STATUS)[keyof typeof RECORDING_STATUS];

// ---------------------------------------------------------------------------
// HTTP status codes used across meeting routes
// ---------------------------------------------------------------------------

export const STATUS_OK = 200;
export const STATUS_CREATED = 201;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_FORBIDDEN = 403;
export const STATUS_NOT_FOUND = 404;
export const STATUS_UNPROCESSABLE = 422;
export const STATUS_INTERNAL_ERROR = 500;
export const STATUS_SERVICE_UNAVAILABLE = 503;

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

export const ERROR_UNAUTHORIZED = "Unauthorized";
export const ERROR_FORBIDDEN =
  "You need to be a group member (or have RSVP'd) to join this meeting.";
export const ERROR_LIVEKIT_NOT_CONFIGURED =
  "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.";
export const ERROR_EVENT_NOT_FOUND = "Event not found";
export const ERROR_NOT_VIRTUAL_MEETING =
  "This event does not host a virtual meeting.";
export const ERROR_OUTSIDE_JOIN_WINDOW =
  "The meeting room opens shortly before the event starts.";

// ---------------------------------------------------------------------------
// Metadata keys stored in resource.metadata for event-linked meetings
// ---------------------------------------------------------------------------

export const META_MEETING_ROOM = "meetingRoom";
export const META_MEETING_CREATED_AT = "meetingCreatedAt";
export const META_MEETING_CREATED_BY = "meetingCreatedBy";
export const META_MEETING_RECORDINGS = "meetingRecordings";
export const META_MEETING_TRANSCRIPT_PROCESSED_AT =
  "meetingTranscriptProcessedAt";
