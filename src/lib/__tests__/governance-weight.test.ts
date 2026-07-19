import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEIGHT_CONFIG,
  describeWeightConfig,
  isWeightKind,
  normalizeWeight,
  parseWeightConfig,
} from "@/lib/governance-weight";

describe("parseWeightConfig", () => {
  it("defaults missing/invalid shapes to the fallback (equal)", () => {
    expect(parseWeightConfig(undefined)).toEqual(DEFAULT_WEIGHT_CONFIG);
    expect(parseWeightConfig(null)).toEqual({ kind: "equal" });
    expect(parseWeightConfig("stake")).toEqual({ kind: "equal" });
    expect(parseWeightConfig({ kind: "plutocracy" })).toEqual({ kind: "equal" });
  });

  it("honors an explicit fallback (org default, decision #2)", () => {
    expect(parseWeightConfig(undefined, { kind: "stake" })).toEqual({ kind: "stake" });
    expect(parseWeightConfig({ kind: "voting-shares" }, { kind: "stake" })).toEqual({ kind: "voting-shares" });
  });

  it("returns a copy (no shared mutable default)", () => {
    expect(parseWeightConfig(undefined)).not.toBe(DEFAULT_WEIGHT_CONFIG);
  });

  it("keeps a badge reference only for badge-weight", () => {
    expect(parseWeightConfig({ kind: "badge-weight", badgeId: " b1 " })).toEqual({
      kind: "badge-weight",
      badgeId: "b1",
    });
    expect(parseWeightConfig({ kind: "stake", badgeId: "b1" })).toEqual({ kind: "stake" });
  });

  it("recognizes exactly the four kinds", () => {
    for (const kind of ["equal", "stake", "voting-shares", "badge-weight"]) {
      expect(isWeightKind(kind)).toBe(true);
    }
    expect(isWeightKind("quadratic")).toBe(false);
  });
});

describe("normalizeWeight", () => {
  it("clamps non-finite/negative to 0 and rounds to 2 decimals", () => {
    expect(normalizeWeight(Number.NaN)).toBe(0);
    expect(normalizeWeight(-3)).toBe(0);
    expect(normalizeWeight(Infinity)).toBe(0);
    expect(normalizeWeight("12")).toBe(12);
    expect(normalizeWeight(1.006)).toBeCloseTo(1.01, 5);
    expect(normalizeWeight(0)).toBe(0);
  });
});

describe("describeWeightConfig", () => {
  it("labels kinds and appends a resolved badge name", () => {
    expect(describeWeightConfig({ kind: "stake" })).toBe("Stake-weighted");
    expect(describeWeightConfig({ kind: "voting-shares" })).toBe("Share-weighted");
    expect(describeWeightConfig({ kind: "badge-weight", badgeId: "b1" }, { badgeName: "Steward" })).toBe(
      "Badge-weighted — Steward",
    );
    expect(describeWeightConfig({ kind: "badge-weight", badgeId: "b1" })).toBe("Badge-weighted");
  });
});
