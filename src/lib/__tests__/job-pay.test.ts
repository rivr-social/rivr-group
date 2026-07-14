/**
 * Unit tests for the shared job pay-label formatter (`@/lib/job-pay`) — the
 * single source of the "Fixed $X / Hourly $X/hr / N points / Volunteer (Thanks)"
 * badge shown on every job card (directive #1). Pure function, no DB.
 *
 * Run with `pnpm test:unit`.
 */
import { describe, it, expect } from "vitest";
import { describeJobPay, formatCentsShort } from "@/lib/job-pay";

describe("formatCentsShort", () => {
  it("drops a whole-dollar .00 but keeps cents", () => {
    expect(formatCentsShort(2500)).toBe("$25");
    expect(formatCentsShort(2550)).toBe("$25.50");
    expect(formatCentsShort(2599)).toBe("$25.99");
  });
});

describe("describeJobPay", () => {
  it("fixed cash", () => {
    expect(describeJobPay({ payKind: "fixed", payAmountCents: 25000 })).toEqual({
      label: "Fixed $250",
      tone: "cash",
    });
  });

  it("hourly cash", () => {
    expect(describeJobPay({ payKind: "hourly", hourlyRateCents: 2500 })).toEqual({
      label: "Hourly $25/hr",
      tone: "cash",
    });
  });

  it("volunteer", () => {
    expect(describeJobPay({ payKind: "volunteer" })).toEqual({
      label: "Volunteer (Thanks)",
      tone: "volunteer",
    });
  });

  it("points from the job pool", () => {
    expect(describeJobPay({ payKind: null, points: 40 })).toEqual({ label: "40 points", tone: "points" });
  });

  it("points fall back to totalPoints when no pool set", () => {
    expect(describeJobPay({ points: null, totalPoints: 15 })).toEqual({ label: "15 points", tone: "points" });
  });

  it("bare label when no points anywhere", () => {
    expect(describeJobPay({})).toEqual({ label: "Points", tone: "points" });
  });

  it("fixed with no positive amount degrades to points, not a broken '$'", () => {
    expect(describeJobPay({ payKind: "fixed", payAmountCents: 0, totalPoints: 5 })).toEqual({
      label: "5 points",
      tone: "points",
    });
  });
});
