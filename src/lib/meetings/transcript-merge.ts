/**
 * Pure transcript-merge engine for Virtual Meeting recordings.
 *
 * Each meeting participant is recorded on their OWN audio track, so
 * per-track transcripts arrive already speaker-attributed (the track's
 * authenticated identity). This module interleaves those per-track
 * segment lists on the shared meeting clock and renders the merged,
 * identity-labeled transcript as markdown.
 *
 * No IO — unit-tested in src/lib/__tests__/transcript-merge.test.ts.
 */

/** One transcribed span within a single participant's track (track-relative). */
export interface TrackTranscriptSegment {
  /** Milliseconds from the start of THIS track's recording. */
  startMs: number;
  endMs: number;
  text: string;
}

/** A participant's full track transcript, anchored to the meeting clock. */
export interface TrackTranscript {
  /** Authenticated identity (agent id) that owned the audio track. */
  identity: string;
  /** Human display name shown as the speaker label. */
  displayName: string;
  /** Epoch ms when this track's recording started. */
  trackStartedAtMs: number;
  segments: TrackTranscriptSegment[];
}

/** A merged, absolute-time segment attributed to a speaker. */
export interface MergedTranscriptSegment {
  identity: string;
  displayName: string;
  /** Epoch ms (trackStartedAtMs + segment startMs). */
  absoluteStartMs: number;
  absoluteEndMs: number;
  text: string;
}

/** Same-speaker segments closer than this are coalesced into one turn. */
export const COALESCE_GAP_MS = 2_000;

/**
 * Interleaves all tracks' segments on the meeting clock, dropping empty
 * text, sorted by absolute start (ties: identity for determinism).
 */
export function mergeTrackTranscripts(
  tracks: TrackTranscript[],
): MergedTranscriptSegment[] {
  const merged: MergedTranscriptSegment[] = [];

  for (const track of tracks) {
    for (const segment of track.segments) {
      const text = segment.text.trim();
      if (!text) continue;
      merged.push({
        identity: track.identity,
        displayName: track.displayName,
        absoluteStartMs: track.trackStartedAtMs + Math.max(0, segment.startMs),
        absoluteEndMs: track.trackStartedAtMs + Math.max(0, segment.endMs),
        text,
      });
    }
  }

  merged.sort(
    (a, b) =>
      a.absoluteStartMs - b.absoluteStartMs ||
      a.identity.localeCompare(b.identity),
  );
  return merged;
}

/**
 * Coalesces consecutive segments by the SAME speaker when the pause
 * between them is under `gapMs` — turns word/phrase fragments into
 * readable speaking turns without reordering anyone.
 */
export function coalesceAdjacentSegments(
  segments: MergedTranscriptSegment[],
  gapMs: number = COALESCE_GAP_MS,
): MergedTranscriptSegment[] {
  const result: MergedTranscriptSegment[] = [];

  for (const segment of segments) {
    const last = result[result.length - 1];
    if (
      last &&
      last.identity === segment.identity &&
      segment.absoluteStartMs - last.absoluteEndMs <= gapMs
    ) {
      last.text = `${last.text} ${segment.text}`;
      last.absoluteEndMs = Math.max(last.absoluteEndMs, segment.absoluteEndMs);
      continue;
    }
    result.push({ ...segment });
  }

  return result;
}

/** Formats an offset from meeting start as [H:MM:SS] / [MM:SS]. */
export function formatMeetingOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export interface RenderTranscriptOptions {
  /** Epoch ms the meeting started (offsets are relative to this). */
  meetingStartMs: number;
  /** Section heading; e.g. the meeting date string. */
  heading: string;
  /** Names of everyone who attended (shown even if they never spoke). */
  participantNames?: string[];
}

/**
 * Renders the merged transcript as a markdown section:
 * one `**Name** [MM:SS]: text` line per speaking turn.
 */
export function renderMeetingTranscriptMarkdown(
  segments: MergedTranscriptSegment[],
  options: RenderTranscriptOptions,
): string {
  const turns = coalesceAdjacentSegments(segments);
  const lines: string[] = [`## ${options.heading}`, ""];

  if (options.participantNames && options.participantNames.length > 0) {
    lines.push(`Participants: ${options.participantNames.join(", ")}`, "");
  }

  if (turns.length === 0) {
    lines.push("_No speech was transcribed for this meeting._", "");
    return lines.join("\n");
  }

  for (const turn of turns) {
    const offset = formatMeetingOffset(
      turn.absoluteStartMs - options.meetingStartMs,
    );
    lines.push(`**${turn.displayName}** [${offset}]: ${turn.text}`, "");
  }

  return lines.join("\n");
}
