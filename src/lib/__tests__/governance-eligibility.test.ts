import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIN_SHARES,
  DEFAULT_PROPOSE_GATE,
  DEFAULT_VOTE_GATE,
  combinedFactNeeds,
  describeEligibilityGate,
  evaluateEligibilityGate,
  gateFactNeeds,
  isEligibilityKind,
  parseEligibilityGate,
  type EligibilityFacts,
  type EligibilityGate,
} from "@/lib/governance-eligibility";

/** Baseline facts: signed-in member with nothing else. */
function memberFacts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    isAuthenticated: true,
    isMember: true,
    isAdmin: false,
    heldBadgeIds: [],
    shareHoldings: {},
    abacAllowed: false,
    ...overrides,
  };
}

describe("parseEligibilityGate", () => {
  it("defaults missing/invalid shapes to the fallback gate", () => {
    expect(parseEligibilityGate(undefined)).toEqual(DEFAULT_VOTE_GATE);
    expect(parseEligibilityGate(null, DEFAULT_PROPOSE_GATE)).toEqual(DEFAULT_PROPOSE_GATE);
    expect(parseEligibilityGate("member")).toEqual(DEFAULT_VOTE_GATE);
    expect(parseEligibilityGate({ kind: "sortition" })).toEqual(DEFAULT_VOTE_GATE);
  });

  it("returns a copy of the fallback (no shared mutable state)", () => {
    const gate = parseEligibilityGate(undefined);
    expect(gate).not.toBe(DEFAULT_VOTE_GATE);
  });

  it("keeps a badge reference only for badge-holder gates", () => {
    expect(parseEligibilityGate({ kind: "badge-holder", badgeId: " b1 " })).toEqual({
      kind: "badge-holder",
      badgeId: "b1",
    });
    expect(parseEligibilityGate({ kind: "member", badgeId: "b1" })).toEqual({ kind: "member" });
  });

  it("normalizes share-holder minShares (default 1; rejects non-positive/fractional)", () => {
    expect(parseEligibilityGate({ kind: "share-holder" })).toEqual({
      kind: "share-holder",
      minShares: DEFAULT_MIN_SHARES,
    });
    expect(parseEligibilityGate({ kind: "share-holder", minShares: 10, shareClassId: "c1" })).toEqual({
      kind: "share-holder",
      minShares: 10,
      shareClassId: "c1",
    });
    expect(parseEligibilityGate({ kind: "share-holder", minShares: 0 }).minShares).toBe(1);
    expect(parseEligibilityGate({ kind: "share-holder", minShares: 2.5 }).minShares).toBe(1);
    expect(parseEligibilityGate({ kind: "share-holder", minShares: "many" }).minShares).toBe(1);
  });

  it("recognizes exactly the six kinds", () => {
    for (const kind of ["public", "member", "badge-holder", "admin", "share-holder", "abac"]) {
      expect(isEligibilityKind(kind)).toBe(true);
    }
    expect(isEligibilityKind("token-holder")).toBe(false);
  });
});

describe("evaluateEligibilityGate", () => {
  it("rejects anonymous actors for EVERY kind, including public", () => {
    const anon = memberFacts({ isAuthenticated: false, isMember: false });
    for (const kind of ["public", "member", "badge-holder", "admin", "share-holder", "abac"] as const) {
      const verdict = evaluateEligibilityGate({ kind }, anon);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toMatch(/signed in/);
    }
  });

  it("public admits any signed-in user, member requires membership", () => {
    const nonMember = memberFacts({ isMember: false });
    expect(evaluateEligibilityGate({ kind: "public" }, nonMember).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "member" }, nonMember).eligible).toBe(false);
    expect(evaluateEligibilityGate({ kind: "member" }, memberFacts()).eligible).toBe(true);
  });

  it("admin requires the admin fact; membership alone is not enough", () => {
    expect(evaluateEligibilityGate({ kind: "admin" }, memberFacts()).eligible).toBe(false);
    expect(evaluateEligibilityGate({ kind: "admin" }, memberFacts({ isAdmin: true })).eligible).toBe(true);
  });

  it("badge-holder: any governance badge when unset, the named badge when set", () => {
    const holder = memberFacts({ heldBadgeIds: ["b1"] });
    expect(evaluateEligibilityGate({ kind: "badge-holder" }, holder).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "badge-holder" }, memberFacts()).eligible).toBe(false);
    expect(evaluateEligibilityGate({ kind: "badge-holder", badgeId: "b1" }, holder).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "badge-holder", badgeId: "b2" }, holder).eligible).toBe(false);
  });

  it("share-holder: named class vs any class, and the minShares floor", () => {
    const holder = memberFacts({ shareHoldings: { c1: 5, c2: 12 } });
    expect(evaluateEligibilityGate({ kind: "share-holder" }, holder).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "share-holder", shareClassId: "c1", minShares: 5 }, holder).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "share-holder", shareClassId: "c1", minShares: 6 }, holder).eligible).toBe(false);
    // Any-class mode uses the LARGEST holding.
    expect(evaluateEligibilityGate({ kind: "share-holder", minShares: 10 }, holder).eligible).toBe(true);
    expect(evaluateEligibilityGate({ kind: "share-holder", minShares: 13 }, holder).eligible).toBe(false);
    expect(evaluateEligibilityGate({ kind: "share-holder" }, memberFacts()).eligible).toBe(false);
  });

  it("share-holder still requires membership (shares without membership fail)", () => {
    const outsider = memberFacts({ isMember: false, shareHoldings: { c1: 100 } });
    const verdict = evaluateEligibilityGate({ kind: "share-holder" }, outsider);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/members/);
  });

  it("abac follows the policy-engine verdict", () => {
    expect(evaluateEligibilityGate({ kind: "abac" }, memberFacts()).eligible).toBe(false);
    expect(evaluateEligibilityGate({ kind: "abac" }, memberFacts({ abacAllowed: true })).eligible).toBe(true);
  });

  it("returns a human reason on every rejection", () => {
    const cases: EligibilityGate[] = [
      { kind: "member" },
      { kind: "admin" },
      { kind: "badge-holder" },
      { kind: "share-holder", minShares: 3 },
      { kind: "abac" },
    ];
    const outsider = memberFacts({ isMember: false });
    for (const gate of cases) {
      const verdict = evaluateEligibilityGate(gate, outsider);
      expect(verdict.eligible).toBe(false);
      expect(typeof verdict.reason).toBe("string");
      expect((verdict.reason ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("fact needs", () => {
  it("maps each kind to only the facts it reads", () => {
    expect(gateFactNeeds({ kind: "public" })).toEqual({ member: false, admin: false, badges: false, shares: false, abac: false });
    expect(gateFactNeeds({ kind: "member" }).member).toBe(true);
    expect(gateFactNeeds({ kind: "admin" }).admin).toBe(true);
    expect(gateFactNeeds({ kind: "badge-holder" }).badges).toBe(true);
    const shares = gateFactNeeds({ kind: "share-holder" });
    expect(shares.shares).toBe(true);
    expect(shares.member).toBe(true); // share-holder also requires membership
    expect(gateFactNeeds({ kind: "abac" }).abac).toBe(true);
  });

  it("combines needs across gates as a union", () => {
    const needs = combinedFactNeeds([{ kind: "member" }, { kind: "badge-holder" }, { kind: "abac" }]);
    expect(needs).toEqual({ member: true, admin: false, badges: true, shares: false, abac: true });
  });
});

describe("describeEligibilityGate", () => {
  it("labels each kind and appends resolved names/floors", () => {
    expect(describeEligibilityGate({ kind: "member" })).toBe("Group members");
    expect(describeEligibilityGate({ kind: "public" })).toBe("Anyone signed in");
    expect(describeEligibilityGate({ kind: "badge-holder", badgeId: "b1" }, { badgeName: "Land Steward" })).toBe(
      "Badge holders — Land Steward",
    );
    expect(describeEligibilityGate({ kind: "badge-holder", badgeId: "b1" })).toBe("Badge holders");
    expect(
      describeEligibilityGate({ kind: "share-holder", shareClassId: "c1", minShares: 10 }, { shareClassName: "Stewards" }),
    ).toBe("Share holders — Stewards, min 10");
    expect(describeEligibilityGate({ kind: "share-holder", minShares: 1 })).toBe("Share holders");
    expect(describeEligibilityGate({ kind: "abac" })).toBe("Custom policy");
  });
});
