import { describe, expect, it } from "vitest";

import {
  decisionPhase,
  deriveProposalOutcome,
  derivePollOutcome,
  isBoardRole,
  requiredFinalizeApprovals,
} from "@/lib/governance-resolution";

describe("requiredFinalizeApprovals (decision #4: 2/3 of board holders)", () => {
  it("is impossible with no board (an org must seat one first)", () => {
    expect(requiredFinalizeApprovals(0)).toBe(Infinity);
    expect(requiredFinalizeApprovals(-1)).toBe(Infinity);
  });

  it("takes ceil(2/3 × holders)", () => {
    expect(requiredFinalizeApprovals(1)).toBe(1);
    expect(requiredFinalizeApprovals(2)).toBe(2);
    expect(requiredFinalizeApprovals(3)).toBe(2);
    expect(requiredFinalizeApprovals(4)).toBe(3);
    expect(requiredFinalizeApprovals(6)).toBe(4);
    expect(requiredFinalizeApprovals(9)).toBe(6);
  });
});

describe("decisionPhase", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it("is active while the window is open", () => {
    expect(decisionPhase({ status: "active", endDate: future })).toBe("active");
  });

  it("closes when endDate passes (derived — never stored)", () => {
    expect(decisionPhase({ status: "active", endDate: past })).toBe("closed");
  });

  it("finalized status wins regardless of dates", () => {
    expect(decisionPhase({ status: "finalized", endDate: future })).toBe("finalized");
  });

  it("treats a missing/invalid endDate as still active", () => {
    expect(decisionPhase({ status: "active" })).toBe("active");
    expect(decisionPhase({ status: "active", endDate: "not-a-date" })).toBe("active");
  });
});

describe("deriveProposalOutcome", () => {
  it("passes on a weighted yes fraction at/above the threshold (abstain excluded)", () => {
    const outcome = deriveProposalOutcome({
      votes: { yes: 6, no: 3, abstain: 5 },
      totalVoters: 14,
      quorum: 0,
      threshold: 66,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.yesFraction).toBeCloseTo(6 / 9, 4);
  });

  it("fails just below the threshold", () => {
    const outcome = deriveProposalOutcome({
      votes: { yes: 65, no: 35, abstain: 0 },
      totalVoters: 100,
      quorum: 0,
      threshold: 66,
    });
    expect(outcome.passed).toBe(false);
  });

  it("fails when quorum is not met even with unanimous yes", () => {
    const outcome = deriveProposalOutcome({
      votes: { yes: 3, no: 0, abstain: 0 },
      totalVoters: 3,
      quorum: 5,
      threshold: 50,
    });
    expect(outcome.quorumMet).toBe(false);
    expect(outcome.passed).toBe(false);
  });

  it("quorum counts RAW voters, not weights", () => {
    // 3 voters with big weights still miss a quorum of 5.
    const outcome = deriveProposalOutcome({
      votes: { yes: 300, no: 0, abstain: 0 },
      totalVoters: 3,
      quorum: 5,
      threshold: 50,
    });
    expect(outcome.passed).toBe(false);
  });

  it("an all-abstain proposal cannot pass (empty decided pool)", () => {
    const outcome = deriveProposalOutcome({
      votes: { yes: 0, no: 0, abstain: 7 },
      totalVoters: 7,
      quorum: 0,
      threshold: 50,
    });
    expect(outcome.passed).toBe(false);
  });
});

describe("derivePollOutcome", () => {
  it("prefers the tally winner (ranked/IRV)", () => {
    expect(
      derivePollOutcome({ tally: { winnerId: "b", options: [{ id: "a", value: 9 }, { id: "b", value: 3 }] } }),
    ).toEqual({ kind: "poll", winnerId: "b" });
  });

  it("falls back to the highest tally value", () => {
    expect(
      derivePollOutcome({ tally: { options: [{ id: "a", value: 2 }, { id: "b", value: 5 }] } }),
    ).toEqual({ kind: "poll", winnerId: "b" });
  });

  it("uses legacy option counts when no tally exists", () => {
    expect(derivePollOutcome({ options: [{ id: "a", votes: 4 }, { id: "b", votes: 1 }] })).toEqual({
      kind: "poll",
      winnerId: "a",
    });
  });

  it("records no winner on a tie or an empty poll", () => {
    expect(derivePollOutcome({ options: [{ id: "a", votes: 2 }, { id: "b", votes: 2 }] }).winnerId).toBeNull();
    expect(derivePollOutcome({ options: [] }).winnerId).toBeNull();
    expect(derivePollOutcome({ options: [{ id: "a", votes: 0 }] }).winnerId).toBeNull();
  });
});

describe("isBoardRole", () => {
  it("recognizes the seed set only", () => {
    for (const role of ["chair", "treasurer", "secretary", "director"]) {
      expect(isBoardRole(role)).toBe(true);
    }
    expect(isBoardRole("ceo")).toBe(false);
  });
});
