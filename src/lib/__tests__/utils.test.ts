/**
 * Unit tests for the hydration-stable date formatter (`@/lib/utils`
 * `formatDateStable`) — the single helper used to render dates in
 * server-rendered markup (job deadlines + comment dates on the job detail
 * page) without a React #418 hydration text mismatch.
 *
 * The suite forces a NON-UTC runtime time zone before importing the helper, so
 * a bare `new Date(x).toLocaleDateString()` would render a DIFFERENT calendar
 * day than a UTC SSR host — exactly the divergence that produced #418. The
 * assertions prove `formatDateStable` pins UTC (and the locale) and therefore
 * returns the same authored day regardless of the runtime zone.
 *
 * Run with `pnpm test:unit`.
 */

// Must run before any Date usage so Node picks up the offset time zone.
process.env.TZ = "America/Los_Angeles"; // UTC-7/8 — behind UTC

import { describe, it, expect } from "vitest";
import { formatDateStable, formatDate } from "@/lib/utils";

describe("formatDateStable", () => {
  it("renders a date-only string as its authored calendar day", () => {
    // "2026-07-16" parses to UTC midnight; in a UTC-behind zone the bare
    // toLocaleDateString would roll back to Jul 15.
    expect(formatDateStable("2026-07-16")).toBe("Jul 16, 2026");
  });

  it("is stable across the runtime time zone (the #418 fix)", () => {
    const utcMidnight = "2026-07-16T00:00:00.000Z";
    // Sanity: the running process really is in a UTC-behind zone, so a bare
    // local format DOES drift to the previous day — the bug we are fixing.
    expect(new Date(utcMidnight).toLocaleDateString("en-US")).toBe("7/15/2026");
    // The stable formatter pins UTC and holds the authored day.
    expect(formatDateStable(utcMidnight)).toBe("Jul 16, 2026");
  });

  it("accepts a Date object as well as a string", () => {
    expect(formatDateStable(new Date("2026-01-05T12:00:00.000Z"))).toBe("Jan 5, 2026");
  });

  it("honors format overrides while still forcing UTC", () => {
    expect(
      formatDateStable("2026-07-16T00:00:00.000Z", { month: "long", day: "numeric", year: "numeric" }),
    ).toBe("July 16, 2026");
  });

  it("differs from the local-zone formatDate for a UTC-midnight timestamp", () => {
    // Documents WHY a dedicated helper exists: formatDate does not pin the
    // zone, so it drifts under a non-UTC runtime; formatDateStable does not.
    const utcMidnight = "2026-07-16T00:00:00.000Z";
    expect(formatDate(utcMidnight)).toBe("Jul 15, 2026");
    expect(formatDateStable(utcMidnight)).toBe("Jul 16, 2026");
  });
});
