import { describe, expect, it } from "vitest";
import {
  isWithinJoinWindow,
  resolveEventWindow,
} from "@/lib/meetings/event-window";
import {
  JOIN_WINDOW_BEFORE_MS,
  JOIN_WINDOW_AFTER_MS,
} from "@/lib/meetings/constants";

const START_ISO = "2026-07-21T18:00:00.000Z";
const END_ISO = "2026-07-21T19:00:00.000Z";
const START_MS = Date.parse(START_ISO);
const END_MS = Date.parse(END_ISO);

describe("resolveEventWindow", () => {
  it("uses explicit startDate/endDate", () => {
    const window = resolveEventWindow({ startDate: START_ISO, endDate: END_ISO });
    expect(window).toEqual({ startMs: START_MS, endMs: END_MS });
  });

  it("composes date + time when startDate is absent", () => {
    const window = resolveEventWindow({ date: "2026-07-21", time: "18:00" });
    expect(window?.startMs).toBe(Date.parse("2026-07-21T18:00"));
  });

  it("defaults the end to two hours after start", () => {
    const window = resolveEventWindow({ startDate: START_ISO });
    expect(window?.endMs).toBe(START_MS + 2 * 60 * 60 * 1000);
  });

  it("returns null when nothing parseable exists", () => {
    expect(resolveEventWindow({})).toBeNull();
    expect(resolveEventWindow(null)).toBeNull();
    expect(resolveEventWindow({ date: "not-a-date" })).toBeNull();
  });
});

describe("isWithinJoinWindow", () => {
  const metadata = { startDate: START_ISO, endDate: END_ISO };

  it("opens shortly before start and closes after the grace period", () => {
    expect(
      isWithinJoinWindow(metadata, START_MS - JOIN_WINDOW_BEFORE_MS + 1),
    ).toBe(true);
    expect(
      isWithinJoinWindow(metadata, START_MS - JOIN_WINDOW_BEFORE_MS - 1),
    ).toBe(false);
    expect(isWithinJoinWindow(metadata, END_MS + JOIN_WINDOW_AFTER_MS - 1)).toBe(
      true,
    );
    expect(isWithinJoinWindow(metadata, END_MS + JOIN_WINDOW_AFTER_MS + 1)).toBe(
      false,
    );
  });

  it("fails open when the schedule is unknown", () => {
    expect(isWithinJoinWindow({}, Date.now())).toBe(true);
  });
});
