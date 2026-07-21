import { describe, expect, it } from "vitest";
import {
  coalesceAdjacentSegments,
  formatMeetingOffset,
  mergeTrackTranscripts,
  renderMeetingTranscriptMarkdown,
  type TrackTranscript,
} from "@/lib/meetings/transcript-merge";

const MEETING_START = 1_700_000_000_000;

function makeTracks(): TrackTranscript[] {
  return [
    {
      identity: "agent-alice",
      displayName: "Alice",
      trackStartedAtMs: MEETING_START,
      segments: [
        { startMs: 0, endMs: 2_000, text: "Welcome everyone." },
        { startMs: 10_000, endMs: 12_000, text: "Any questions?" },
      ],
    },
    {
      identity: "agent-bob",
      displayName: "Bob",
      trackStartedAtMs: MEETING_START + 1_000, // joined a second later
      segments: [{ startMs: 4_000, endMs: 6_000, text: "Yes — about the budget." }],
    },
  ];
}

describe("mergeTrackTranscripts", () => {
  it("interleaves speakers on the meeting clock", () => {
    const merged = mergeTrackTranscripts(makeTracks());
    expect(merged.map((segment) => segment.displayName)).toEqual([
      "Alice",
      "Bob",
      "Alice",
    ]);
    // Bob's absolute time = track start (+1s) + segment offset (4s).
    expect(merged[1].absoluteStartMs).toBe(MEETING_START + 5_000);
  });

  it("drops empty segments", () => {
    const merged = mergeTrackTranscripts([
      {
        identity: "a",
        displayName: "A",
        trackStartedAtMs: 0,
        segments: [{ startMs: 0, endMs: 1, text: "   " }],
      },
    ]);
    expect(merged).toEqual([]);
  });

  it("orders deterministically on start-time ties", () => {
    const merged = mergeTrackTranscripts([
      {
        identity: "b",
        displayName: "B",
        trackStartedAtMs: 0,
        segments: [{ startMs: 0, endMs: 1_000, text: "same time b" }],
      },
      {
        identity: "a",
        displayName: "A",
        trackStartedAtMs: 0,
        segments: [{ startMs: 0, endMs: 1_000, text: "same time a" }],
      },
    ]);
    expect(merged.map((segment) => segment.identity)).toEqual(["a", "b"]);
  });
});

describe("coalesceAdjacentSegments", () => {
  it("joins consecutive same-speaker fragments within the gap", () => {
    const merged = mergeTrackTranscripts([
      {
        identity: "a",
        displayName: "A",
        trackStartedAtMs: 0,
        segments: [
          { startMs: 0, endMs: 1_000, text: "Hello" },
          { startMs: 1_500, endMs: 2_500, text: "there." },
        ],
      },
    ]);
    const turns = coalesceAdjacentSegments(merged, 2_000);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Hello there.");
    expect(turns[0].absoluteEndMs).toBe(2_500);
  });

  it("keeps different speakers separate even when contiguous", () => {
    const turns = coalesceAdjacentSegments(
      mergeTrackTranscripts(makeTracks()),
      60_000,
    );
    expect(turns.length).toBe(3);
  });
});

describe("formatMeetingOffset", () => {
  it("formats minutes/seconds and hours", () => {
    expect(formatMeetingOffset(0)).toBe("00:00");
    expect(formatMeetingOffset(65_000)).toBe("01:05");
    expect(formatMeetingOffset(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatMeetingOffset(-5_000)).toBe("00:00");
  });
});

describe("renderMeetingTranscriptMarkdown", () => {
  it("renders speaker-labeled lines with offsets", () => {
    const markdown = renderMeetingTranscriptMarkdown(
      mergeTrackTranscripts(makeTracks()),
      {
        meetingStartMs: MEETING_START,
        heading: "Virtual Meeting — Test",
        participantNames: ["Alice", "Bob"],
      },
    );
    expect(markdown).toContain("## Virtual Meeting — Test");
    expect(markdown).toContain("Participants: Alice, Bob");
    expect(markdown).toContain("**Alice** [00:00]: Welcome everyone.");
    expect(markdown).toContain("**Bob** [00:05]: Yes — about the budget.");
  });

  it("notes when nothing was transcribed", () => {
    const markdown = renderMeetingTranscriptMarkdown([], {
      meetingStartMs: 0,
      heading: "Empty",
    });
    expect(markdown).toContain("_No speech was transcribed for this meeting._");
  });
});
