/**
 * Unit tests for the pure peer point-allocation math
 * (`@/lib/peer-allocation`): per-rater normalization, self-rating exclusion,
 * non-assignee weight discarding, averaging across raters, equal-split
 * fallback, and exact-sum largest-remainder integer conversion.
 */
import { describe, it, expect } from "vitest";
import { computePeerShareFractions, allocatePointsByShares } from "./peer-allocation";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

describe("computePeerShareFractions", () => {
  it("splits equally with no inputs", () => {
    const shares = computePeerShareFractions([A, B], null);
    expect(shares.get(A)).toBeCloseTo(0.5);
    expect(shares.get(B)).toBeCloseTo(0.5);
  });

  it("normalizes a single rater's weights over the others", () => {
    const shares = computePeerShareFractions([A, B, C], { [A]: { [B]: 3, [C]: 1 } });
    expect(shares.get(B)).toBeCloseTo(0.75);
    expect(shares.get(C)).toBeCloseTo(0.25);
    expect(shares.get(A)).toBeCloseTo(0); // nobody rated A
  });

  it("ignores self-ratings and non-assignee weights", () => {
    const shares = computePeerShareFractions([A, B], {
      [A]: { [A]: 100, [B]: 1, [C]: 50 }, // self + outsider discarded
    });
    expect(shares.get(B)).toBeCloseTo(1);
    expect(shares.get(A)).toBeCloseTo(0);
  });

  it("averages across raters", () => {
    const shares = computePeerShareFractions([A, B, C], {
      [A]: { [B]: 1, [C]: 1 }, // B .5, C .5
      [B]: { [A]: 1, [C]: 3 }, // A .25, C .75
    });
    expect(shares.get(A)).toBeCloseTo(0.125);
    expect(shares.get(B)).toBeCloseTo(0.25);
    expect(shares.get(C)).toBeCloseTo(0.625);
  });

  it("ignores raters who are not assignees and all-zero raters", () => {
    const shares = computePeerShareFractions([A, B], {
      [C]: { [A]: 5 }, // outsider rater
      [A]: { [B]: 0 }, // zero weights contribute nothing
    });
    // No usable input → equal split.
    expect(shares.get(A)).toBeCloseTo(0.5);
    expect(shares.get(B)).toBeCloseTo(0.5);
  });
});

describe("allocatePointsByShares", () => {
  it("sums exactly to the pool (largest remainder)", () => {
    const points = allocatePointsByShares(100, [A, B, C], {
      [A]: { [B]: 1, [C]: 1 },
      [B]: { [A]: 1, [C]: 3 },
    });
    const total = [...points.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
    // A (12.5) and C (62.5) tie on remainder .5 — the tie breaks by id
    // order, so A takes the leftover point deterministically.
    expect(points.get(A)).toBe(13);
    expect(points.get(B)).toBe(25);
    expect(points.get(C)).toBe(62);
  });

  it("equal split with no inputs, exact total", () => {
    const points = allocatePointsByShares(10, [A, B, C], null);
    const values = [...points.values()].sort((a, b) => b - a);
    expect(values.reduce((s, v) => s + v, 0)).toBe(10);
    expect(values).toEqual([4, 3, 3]);
  });

  it("zero/invalid pools allocate nothing", () => {
    const points = allocatePointsByShares(0, [A, B], null);
    expect(points.get(A)).toBe(0);
    expect(points.get(B)).toBe(0);
  });

  it("single assignee takes the whole pool", () => {
    const points = allocatePointsByShares(7, [A], null);
    expect(points.get(A)).toBe(7);
  });
});
