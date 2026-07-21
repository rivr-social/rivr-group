/**
 * POST /api/livekit/webhook — LiveKit server webhook consumer.
 *
 * Drives Virtual Meeting recording + transcription:
 *   track_published  → start a per-participant audio track egress
 *                      (one file per authenticated identity — this is what
 *                      makes the transcript speaker-correlated).
 *   egress_ended     → mark that participant's recording complete.
 *   room_finished    → stamp the meeting end.
 * After egress_ended/room_finished, when the meeting has ended and no
 * recording is still active, all track files are transcribed, merged on
 * the meeting clock, and landed as the event's transcript document.
 *
 * Auth: LiveKit signs each delivery with a JWT over the body using our
 * API key/secret; receiveWebhookEvent verifies it — no session involved.
 */

import { NextResponse } from "next/server";
import {
  getLiveKitConfig,
  getRecordingStorageConfig,
  isMeetingRecordingConfigured,
  receiveWebhookEvent,
  startTrackAudioEgress,
} from "@/lib/meetings/livekit";
import {
  MEETING_KIND_VIRTUAL,
  META_MEETING_RECORDINGS,
  META_MEETING_TRANSCRIPT_PROCESSED_AT,
  RECORDING_STATUS,
  STATUS_OK,
  STATUS_SERVICE_UNAVAILABLE,
  STATUS_UNAUTHORIZED,
  eventIdFromRoomName,
} from "@/lib/meetings/constants";
import {
  hasActiveRecordingForTrack,
  parseMeetingRecordings,
  patchMeetingRecording,
  upsertMeetingRecording,
  type MeetingRecordingEntry,
} from "@/lib/meetings/meeting-recordings";
import {
  landMeetingTranscriptSection,
  loadTranscriptEventContext,
  patchEventMetadata,
} from "@/lib/meetings/transcript-land";
import {
  mergeTrackTranscripts,
  renderMeetingTranscriptMarkdown,
  type TrackTranscript,
} from "@/lib/meetings/transcript-merge";
import { downloadRecordingAsFile } from "@/lib/meetings/recording-storage";
import { transcribeAudioFileDetailed } from "@/lib/transcription";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Epoch-ms end of the meeting, stamped on room_finished. */
const META_MEETING_ENDED_AT_MS = "meetingEndedAtMs";

function bigintNsToMs(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value / 1_000_000n);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Some SDK versions surface ns as number.
    return value > 1e15 ? Math.round(value / 1e6) : value;
  }
  return null;
}

async function handleTrackPublished(event: {
  room?: { name?: string };
  participant?: { identity?: string; name?: string };
  track?: { sid?: string; type?: unknown; source?: unknown };
}): Promise<void> {
  const roomName = event.room?.name ?? "";
  const eventId = eventIdFromRoomName(roomName);
  if (!eventId) return;

  const trackSid = event.track?.sid;
  const identity = event.participant?.identity;
  if (!trackSid || !identity) return;

  // Only audio tracks feed the transcript. The SDK surfaces protobuf enums
  // as numbers or names depending on version — accept both spellings.
  const trackType = event.track?.type;
  const isAudio =
    trackType === 0 || trackType === "AUDIO" || `${trackType}` === "0";
  if (!isAudio) return;

  const config = getLiveKitConfig();
  const storage = getRecordingStorageConfig();
  if (!config || !storage) return;

  const context = await loadTranscriptEventContext(eventId);
  if (!context) return;
  if (context.eventMetadata.meetingKind !== MEETING_KIND_VIRTUAL) return;
  if (context.eventMetadata.transcriptionEnabled === false) return;

  const recordings = parseMeetingRecordings(context.eventMetadata);
  if (hasActiveRecordingForTrack(recordings, trackSid)) return;

  const fileKey = `meetings/${eventId}/${identity}-${trackSid}.ogg`;
  try {
    const info = await startTrackAudioEgress(
      config,
      storage,
      roomName,
      trackSid,
      fileKey,
    );

    const entry: MeetingRecordingEntry = {
      egressId: info.egressId,
      trackSid,
      identity,
      displayName: event.participant?.name?.trim() || identity,
      fileKey,
      status: RECORDING_STATUS.RECORDING,
      startedAtMs: Date.now(),
    };
    await patchEventMetadata(eventId, {
      [META_MEETING_RECORDINGS]: upsertMeetingRecording(recordings, entry),
    });
    console.log(
      `[virtual-meeting] recording started: event=${eventId} identity=${identity} egress=${info.egressId}`,
    );
  } catch (error) {
    console.error(
      `[virtual-meeting] failed to start track egress for event=${eventId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function handleEgressEnded(event: {
  egressInfo?: { egressId?: string; roomName?: string; endedAt?: unknown };
}): Promise<void> {
  const egressId = event.egressInfo?.egressId;
  const roomName = event.egressInfo?.roomName ?? "";
  const eventId = eventIdFromRoomName(roomName);
  if (!egressId || !eventId) return;

  const context = await loadTranscriptEventContext(eventId);
  if (!context) return;

  const recordings = parseMeetingRecordings(context.eventMetadata);
  if (!recordings.some((entry) => entry.egressId === egressId)) return;

  await patchEventMetadata(eventId, {
    [META_MEETING_RECORDINGS]: patchMeetingRecording(recordings, egressId, {
      status: RECORDING_STATUS.COMPLETE,
      endedAtMs: bigintNsToMs(event.egressInfo?.endedAt) ?? Date.now(),
    }),
  });

  await maybeProcessMeetingTranscript(eventId);
}

async function handleRoomFinished(event: {
  room?: { name?: string };
}): Promise<void> {
  const eventId = eventIdFromRoomName(event.room?.name ?? "");
  if (!eventId) return;

  const context = await loadTranscriptEventContext(eventId);
  if (!context) return;
  if (typeof context.eventMetadata[META_MEETING_ENDED_AT_MS] !== "number") {
    await patchEventMetadata(eventId, {
      [META_MEETING_ENDED_AT_MS]: Date.now(),
    });
  }

  await maybeProcessMeetingTranscript(eventId);
}

/**
 * Transcribes + merges + lands the meeting transcript once the meeting has
 * ended and every started recording has finished. Idempotent via the
 * processed-at stamp (best-effort: webhook redeliveries within the same
 * instant could double-run; the stamp is written before the slow work to
 * keep that window tiny).
 */
async function maybeProcessMeetingTranscript(eventId: string): Promise<void> {
  const context = await loadTranscriptEventContext(eventId);
  if (!context) return;

  const metadata = context.eventMetadata;
  if (metadata[META_MEETING_TRANSCRIPT_PROCESSED_AT]) return;
  if (typeof metadata[META_MEETING_ENDED_AT_MS] !== "number") return;

  const recordings = parseMeetingRecordings(metadata);
  if (recordings.length === 0) return;
  if (recordings.some((entry) => entry.status === RECORDING_STATUS.RECORDING)) {
    return; // an egress is still finishing; its egress_ended will re-enter
  }

  // Claim the work before the slow part (narrow double-run window).
  await patchEventMetadata(eventId, {
    [META_MEETING_TRANSCRIPT_PROCESSED_AT]: new Date().toISOString(),
  });

  const tracks: TrackTranscript[] = [];
  let processed = recordings;

  for (const entry of recordings) {
    if (entry.status !== RECORDING_STATUS.COMPLETE) continue;
    try {
      const file = await downloadRecordingAsFile(entry.fileKey);
      const result = await transcribeAudioFileDetailed(file);
      tracks.push({
        identity: entry.identity,
        displayName: entry.displayName,
        trackStartedAtMs: entry.startedAtMs,
        segments: result.segments,
      });
      processed = patchMeetingRecording(processed, entry.egressId, {
        status: RECORDING_STATUS.TRANSCRIBED,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "transcription failed";
      console.error(
        `[virtual-meeting] track transcription failed (event=${eventId}, egress=${entry.egressId}): ${message}`,
      );
      processed = patchMeetingRecording(processed, entry.egressId, {
        status: RECORDING_STATUS.FAILED,
        error: message,
      });
    }
  }

  const meetingStartMs = Math.min(
    ...recordings.map((entry) => entry.startedAtMs),
  );
  const merged = mergeTrackTranscripts(tracks);
  const heading = `Virtual Meeting — ${new Date(meetingStartMs).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  })}`;
  const markdown = renderMeetingTranscriptMarkdown(merged, {
    meetingStartMs,
    heading,
    participantNames: Array.from(
      new Set(recordings.map((entry) => entry.displayName)),
    ),
  });

  const documentId = await landMeetingTranscriptSection(
    context,
    markdown,
    Array.from(new Set(recordings.map((entry) => entry.identity))),
  );
  await patchEventMetadata(eventId, {
    [META_MEETING_RECORDINGS]: processed,
  });

  console.log(
    `[virtual-meeting] transcript landed: event=${eventId} doc=${documentId} tracks=${tracks.length}/${recordings.length}`,
  );
}

export async function POST(request: Request) {
  const config = getLiveKitConfig();
  if (!config) {
    return NextResponse.json(
      { error: "LiveKit is not configured" },
      { status: STATUS_SERVICE_UNAVAILABLE },
    );
  }

  const body = await request.text();
  let webhookEvent;
  try {
    webhookEvent = await receiveWebhookEvent(
      config,
      body,
      request.headers.get("authorization"),
    );
  } catch (error) {
    console.error(
      "LiveKit webhook verification failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  try {
    switch (webhookEvent.event) {
      case "track_published":
        if (isMeetingRecordingConfigured()) {
          await handleTrackPublished(webhookEvent);
        }
        break;
      case "egress_ended":
        await handleEgressEnded(webhookEvent);
        break;
      case "room_finished":
        await handleRoomFinished(webhookEvent);
        break;
      default:
        break; // other lifecycle events are irrelevant here
    }
  } catch (error) {
    // Never bounce the webhook — LiveKit retries aggressively and the
    // handlers are individually idempotent.
    console.error(
      `LiveKit webhook handler error (${webhookEvent.event}):`,
      error instanceof Error ? error.message : error,
    );
  }

  return NextResponse.json({ ok: true }, { status: STATUS_OK });
}
