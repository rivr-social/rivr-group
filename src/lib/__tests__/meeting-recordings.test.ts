import { describe, expect, it } from "vitest";
import {
  hasActiveRecordingForTrack,
  parseMeetingRecordings,
  patchMeetingRecording,
  upsertMeetingRecording,
  type MeetingRecordingEntry,
} from "@/lib/meetings/meeting-recordings";
import {
  META_MEETING_RECORDINGS,
  RECORDING_STATUS,
} from "@/lib/meetings/constants";

function entry(overrides: Partial<MeetingRecordingEntry> = {}): MeetingRecordingEntry {
  return {
    egressId: "eg-1",
    trackSid: "tr-1",
    identity: "agent-1",
    displayName: "Agent One",
    fileKey: "meetings/e1/agent-1-tr-1.ogg",
    status: RECORDING_STATUS.RECORDING,
    startedAtMs: 1_000,
    ...overrides,
  };
}

describe("parseMeetingRecordings", () => {
  it("reads valid entries and drops malformed ones", () => {
    const parsed = parseMeetingRecordings({
      [META_MEETING_RECORDINGS]: [
        entry(),
        { egressId: "missing-everything" },
        "not-an-object",
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].egressId).toBe("eg-1");
  });

  it("defaults displayName to identity and status to recording", () => {
    const parsed = parseMeetingRecordings({
      [META_MEETING_RECORDINGS]: [
        {
          egressId: "e",
          trackSid: "t",
          identity: "id-1",
          fileKey: "k",
          startedAtMs: 5,
          status: "bogus",
        },
      ],
    });
    expect(parsed[0].displayName).toBe("id-1");
    expect(parsed[0].status).toBe(RECORDING_STATUS.RECORDING);
  });

  it("returns empty for absent metadata", () => {
    expect(parseMeetingRecordings(null)).toEqual([]);
    expect(parseMeetingRecordings({})).toEqual([]);
  });
});

describe("upsertMeetingRecording", () => {
  it("appends new entries and merges on egressId", () => {
    const list = upsertMeetingRecording([], entry());
    expect(list).toHaveLength(1);

    const merged = upsertMeetingRecording(list, {
      ...entry(),
      status: RECORDING_STATUS.COMPLETE,
      endedAtMs: 9_000,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe(RECORDING_STATUS.COMPLETE);
    expect(merged[0].endedAtMs).toBe(9_000);
  });
});

describe("patchMeetingRecording", () => {
  it("patches only the matching entry", () => {
    const list = [entry(), entry({ egressId: "eg-2", trackSid: "tr-2" })];
    const patched = patchMeetingRecording(list, "eg-2", {
      status: RECORDING_STATUS.FAILED,
      error: "boom",
    });
    expect(patched[0].status).toBe(RECORDING_STATUS.RECORDING);
    expect(patched[1].status).toBe(RECORDING_STATUS.FAILED);
    expect(patched[1].error).toBe("boom");
  });
});

describe("hasActiveRecordingForTrack", () => {
  it("is true only while a track's recording is active", () => {
    const list = [entry()];
    expect(hasActiveRecordingForTrack(list, "tr-1")).toBe(true);
    expect(hasActiveRecordingForTrack(list, "tr-2")).toBe(false);
    const done = patchMeetingRecording(list, "eg-1", {
      status: RECORDING_STATUS.COMPLETE,
    });
    expect(hasActiveRecordingForTrack(done, "tr-1")).toBe(false);
  });
});
