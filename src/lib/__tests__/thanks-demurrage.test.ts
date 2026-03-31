import { describe, expect, it } from "vitest";

import {
  calculateThanksTokenAgeWeeks,
  calculateThanksTokenWeeklyContribution,
  getThanksDemurrageCycleKey,
  summarizeThanksTokenDemurrage,
  type ThanksTokenDemurrageSnapshot,
} from "@/lib/thanks-demurrage-core";

describe("thanks demurrage math", () => {
  it("ignores tokens younger than one week", () => {
    expect(calculateThanksTokenWeeklyContribution(0.99)).toBe(0);
  });

  it("uses the base weekly burn rate at one week", () => {
    expect(calculateThanksTokenWeeklyContribution(1)).toBeCloseTo(0.0175, 6);
  });

  it("increases contribution as token age increases", () => {
    const weekOne = calculateThanksTokenWeeklyContribution(1);
    const weekTwo = calculateThanksTokenWeeklyContribution(2);
    expect(weekTwo).toBeGreaterThan(weekOne);
    expect(weekTwo).toBeCloseTo(0.0182, 3);
  });

  it("computes token age in weeks from entered_account_at", () => {
    const now = new Date("2026-03-12T00:00:00.000Z");
    const enteredAt = new Date("2026-03-05T00:00:00.000Z");
    expect(calculateThanksTokenAgeWeeks(enteredAt, now)).toBeCloseTo(1, 6);
  });
});

describe("thanks demurrage summary", () => {
  const now = new Date("2026-03-12T00:00:00.000Z");

  function token(id: string, enteredAt: string): ThanksTokenDemurrageSnapshot {
    return {
      id,
      ownerId: "owner-1",
      enteredAccountAt: new Date(enteredAt),
      createdAt: new Date(enteredAt),
      metadata: {},
    };
  }

  it("burns only whole tokens and carries fractional remainder", () => {
    const tokens = Array.from({ length: 100 }, (_, index) =>
      token(`token-${index + 1}`, "2026-03-05T00:00:00.000Z"),
    );

    const summary = summarizeThanksTokenDemurrage("owner-1", tokens, 0, now);

    expect(summary.cycleKey).toBe(getThanksDemurrageCycleKey(now));
    expect(summary.eligibleTokenCount).toBe(100);
    expect(summary.totalContribution).toBeCloseTo(1.75, 6);
    expect(summary.burnCount).toBe(1);
    expect(summary.remainderAfter).toBeCloseTo(0.75, 6);
    expect(summary.burnedTokenIds).toEqual(["token-1"]);
  });

  it("burns the oldest tokens first", () => {
    const tokens = [
      token("oldest", "2026-01-01T00:00:00.000Z"),
      token("middle", "2026-02-01T00:00:00.000Z"),
      token("newest", "2026-03-04T00:00:00.000Z"),
    ];

    const summary = summarizeThanksTokenDemurrage("owner-1", tokens, 1.2, now);

    expect(summary.burnCount).toBe(1);
    expect(summary.burnedTokenIds).toEqual(["oldest"]);
  });

  it("respects previously accumulated hidden remainder", () => {
    const tokens = [token("token-1", "2026-03-05T00:00:00.000Z")];

    const summary = summarizeThanksTokenDemurrage("owner-1", tokens, 0.99, now);

    expect(summary.burnCount).toBe(1);
    expect(summary.remainderAfter).toBeCloseTo(0.0075, 6);
  });

  it("uses a stable seven-day cycle key for idempotent weekly runs", () => {
    const first = new Date("2026-03-12T00:00:00.000Z");
    const second = new Date("2026-03-13T23:59:59.000Z");
    const nextWeek = new Date("2026-03-19T00:00:00.000Z");

    expect(getThanksDemurrageCycleKey(first)).toBe(getThanksDemurrageCycleKey(second));
    expect(getThanksDemurrageCycleKey(nextWeek)).not.toBe(getThanksDemurrageCycleKey(first));
  });
});
