import { describe, expect, it } from "vitest";
import {
  BALLOT_STYLES,
  DEFAULT_CREDITS_PER_VOTER,
  DEFAULT_SCORE_MAX,
  ballotFromStored,
  instantRunoffWinner,
  isBallotStyle,
  resolveCreditsPerVoter,
  resolveScoreMax,
  tallyBallots,
  tallyWeightedBallots,
  validateBallot,
  type Ballot,
  type PollBallotConfig,
} from "../governance-ballot";

const OPTIONS = ["a", "b", "c"];

describe("governance-ballot — config resolution", () => {
  it("exposes exactly the six ballot styles", () => {
    expect(BALLOT_STYLES).toEqual([
      "multiple-choice",
      "approval",
      "score",
      "ranked",
      "rate-rank",
      "quadratic",
    ]);
  });

  it("isBallotStyle guards unknown values", () => {
    expect(isBallotStyle("quadratic")).toBe(true);
    expect(isBallotStyle("nope")).toBe(false);
    expect(isBallotStyle(3)).toBe(false);
  });

  it("clamps scoreMax and creditsPerVoter to sane defaults", () => {
    expect(resolveScoreMax({ ballotStyle: "score" })).toBe(DEFAULT_SCORE_MAX);
    expect(resolveScoreMax({ ballotStyle: "score", scoreMax: 7 })).toBe(7);
    expect(resolveScoreMax({ ballotStyle: "score", scoreMax: 999 })).toBe(DEFAULT_SCORE_MAX);
    expect(resolveScoreMax({ ballotStyle: "score", scoreMax: 0 })).toBe(DEFAULT_SCORE_MAX);
    expect(resolveCreditsPerVoter({ ballotStyle: "quadratic" })).toBe(DEFAULT_CREDITS_PER_VOTER);
    expect(resolveCreditsPerVoter({ ballotStyle: "quadratic", creditsPerVoter: 50 })).toBe(50);
    expect(resolveCreditsPerVoter({ ballotStyle: "quadratic", creditsPerVoter: -5 })).toBe(DEFAULT_CREDITS_PER_VOTER);
  });
});

describe("validateBallot", () => {
  it("multiple-choice accepts a valid option (string or object) and rejects others", () => {
    const cfg: PollBallotConfig = { ballotStyle: "multiple-choice" };
    expect(validateBallot(cfg, OPTIONS, "a")).toEqual({ ok: true, ballot: { style: "multiple-choice", choice: "a" } });
    expect(validateBallot(cfg, OPTIONS, { choice: "b" })).toEqual({ ok: true, ballot: { style: "multiple-choice", choice: "b" } });
    expect(validateBallot(cfg, OPTIONS, "z").ok).toBe(false);
    expect(validateBallot(cfg, OPTIONS, {}).ok).toBe(false);
  });

  it("approval dedupes, drops invalid ids, requires ≥1", () => {
    const cfg: PollBallotConfig = { ballotStyle: "approval" };
    expect(validateBallot(cfg, OPTIONS, { selections: ["a", "a", "b", "z"] })).toEqual({
      ok: true,
      ballot: { style: "approval", selections: ["a", "b"] },
    });
    expect(validateBallot(cfg, OPTIONS, { selections: [] }).ok).toBe(false);
    expect(validateBallot(cfg, OPTIONS, { selections: ["z"] }).ok).toBe(false);
  });

  it("score clamps to range and rejects out-of-range", () => {
    const cfg: PollBallotConfig = { ballotStyle: "score", scoreMax: 5 };
    const ok = validateBallot(cfg, OPTIONS, { scores: { a: 5, b: 0 } });
    expect(ok).toEqual({ ok: true, ballot: { style: "score", scores: { a: 5, b: 0 } } });
    expect(validateBallot(cfg, OPTIONS, { scores: { a: 6 } }).ok).toBe(false);
    expect(validateBallot(cfg, OPTIONS, { scores: {} }).ok).toBe(false);
  });

  it("ranked dedupes preserving order and drops invalid ids", () => {
    const cfg: PollBallotConfig = { ballotStyle: "ranked" };
    expect(validateBallot(cfg, OPTIONS, { ranking: ["c", "a", "c", "z", "b"] })).toEqual({
      ok: true,
      ballot: { style: "ranked", ranking: ["c", "a", "b"] },
    });
    expect(validateBallot(cfg, OPTIONS, { ranking: [] }).ok).toBe(false);
  });

  it("rate-rank requires score+importance per rated option, clamps both", () => {
    const cfg: PollBallotConfig = { ballotStyle: "rate-rank", scoreMax: 5 };
    const ok = validateBallot(cfg, OPTIONS, { ratings: { a: { score: 4, importance: 5 }, b: { score: 1, importance: 1 } } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.ballot).toEqual({ style: "rate-rank", ratings: { a: { score: 4, importance: 5 }, b: { score: 1, importance: 1 } } });
    expect(validateBallot(cfg, OPTIONS, { ratings: { a: { score: 9, importance: 1 } } }).ok).toBe(false);
    expect(validateBallot(cfg, OPTIONS, { ratings: {} }).ok).toBe(false);
  });

  it("quadratic enforces the per-voter budget", () => {
    const cfg: PollBallotConfig = { ballotStyle: "quadratic", creditsPerVoter: 100 };
    expect(validateBallot(cfg, OPTIONS, { credits: { a: 64, b: 36 } })).toEqual({
      ok: true,
      ballot: { style: "quadratic", credits: { a: 64, b: 36 } },
    });
    expect(validateBallot(cfg, OPTIONS, { credits: { a: 80, b: 80 } }).ok).toBe(false); // 160 > 100
    expect(validateBallot(cfg, OPTIONS, { credits: {} }).ok).toBe(false);
    expect(validateBallot(cfg, OPTIONS, { credits: { a: 0 } }).ok).toBe(false);
  });
});

describe("ballotFromStored", () => {
  it("returns a stored ballot object verbatim when it carries a style", () => {
    const stored = { style: "approval", selections: ["a"] };
    expect(ballotFromStored("approval", stored, null)).toEqual(stored);
  });
  it("reconstructs a legacy multiple-choice ballot from metadata.vote", () => {
    expect(ballotFromStored("multiple-choice", null, "b")).toEqual({ style: "multiple-choice", choice: "b" });
  });
  it("returns null when nothing usable is present", () => {
    expect(ballotFromStored("score", null, "b")).toBeNull();
  });
});

describe("tallyBallots — multiple-choice & approval", () => {
  it("multiple-choice counts one per ballot", () => {
    const cfg: PollBallotConfig = { ballotStyle: "multiple-choice" };
    const ballots: Ballot[] = [
      { style: "multiple-choice", choice: "a" },
      { style: "multiple-choice", choice: "a" },
      { style: "multiple-choice", choice: "b" },
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.totalVotes).toBe(3);
    expect(t.options.find((o) => o.id === "a")!.value).toBe(2);
    expect(t.options.find((o) => o.id === "a")!.label).toBe("67% (2)");
    expect(t.options.find((o) => o.id === "c")!.value).toBe(0);
  });

  it("approval counts each selected option; fractions are approval rates", () => {
    const cfg: PollBallotConfig = { ballotStyle: "approval" };
    const ballots: Ballot[] = [
      { style: "approval", selections: ["a", "b"] },
      { style: "approval", selections: ["a"] },
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.totalVotes).toBe(2);
    expect(t.options.find((o) => o.id === "a")!.value).toBe(2);
    expect(t.options.find((o) => o.id === "a")!.fraction).toBe(1);
    expect(t.options.find((o) => o.id === "b")!.value).toBe(1);
  });
});

describe("tallyBallots — score & rate-rank", () => {
  it("score averages per option over its scorers", () => {
    const cfg: PollBallotConfig = { ballotStyle: "score", scoreMax: 5 };
    const ballots: Ballot[] = [
      { style: "score", scores: { a: 5, b: 1 } },
      { style: "score", scores: { a: 3 } },
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.options.find((o) => o.id === "a")!.value).toBe(4); // (5+3)/2
    expect(t.options.find((o) => o.id === "b")!.value).toBe(1);
    expect(t.options.find((o) => o.id === "a")!.fraction).toBeCloseTo(0.8);
  });

  it("rate-rank is salience-weighted: Σ(score·importance)/Σimportance", () => {
    const cfg: PollBallotConfig = { ballotStyle: "rate-rank", scoreMax: 5 };
    const ballots: Ballot[] = [
      // a: voter1 score5 imp5, voter2 score1 imp1 → (25+1)/(5+1)=4.33
      { style: "rate-rank", ratings: { a: { score: 5, importance: 5 } } },
      { style: "rate-rank", ratings: { a: { score: 1, importance: 1 } } },
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.options.find((o) => o.id === "a")!.value).toBeCloseTo(4.33, 1);
  });
});

describe("tallyBallots — quadratic", () => {
  it("aggregates voice as Σ√credits per option", () => {
    const cfg: PollBallotConfig = { ballotStyle: "quadratic", creditsPerVoter: 100 };
    const ballots: Ballot[] = [
      { style: "quadratic", credits: { a: 100 } }, // √100 = 10
      { style: "quadratic", credits: { a: 4, b: 9 } }, // √4=2, √9=3
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.options.find((o) => o.id === "a")!.value).toBe(12); // 10 + 2
    expect(t.options.find((o) => o.id === "b")!.value).toBe(3);
    // anti-whale: 100 credits on one option buys only 10 voice, not 100.
    expect(t.options.find((o) => o.id === "a")!.value).toBeLessThan(100);
  });
});

describe("instantRunoffWinner (ranked)", () => {
  it("elects an immediate first-round majority", () => {
    const winner = instantRunoffWinner(
      [["a"], ["a"], ["a"], ["b"], ["c"]],
      OPTIONS,
    );
    expect(winner).toBe("a"); // 3/5 first-choice majority
  });

  it("redistributes lowest to reach a majority", () => {
    // 1st round: a=2, b=2, c=1. c eliminated; c's ballot ranked b next → b=3 wins.
    const winner = instantRunoffWinner(
      [["a"], ["a"], ["b"], ["b"], ["c", "b"]],
      OPTIONS,
    );
    expect(winner).toBe("b");
  });

  it("returns undefined with no ballots", () => {
    expect(instantRunoffWinner([], OPTIONS)).toBeUndefined();
  });

  it("tallyBallots(ranked) exposes the IRV winner and first-choice counts", () => {
    const cfg: PollBallotConfig = { ballotStyle: "ranked" };
    const ballots: Ballot[] = [
      { style: "ranked", ranking: ["a"] },
      { style: "ranked", ranking: ["a"] },
      { style: "ranked", ranking: ["b"] },
      { style: "ranked", ranking: ["b"] },
      { style: "ranked", ranking: ["c", "b"] },
    ];
    const t = tallyBallots(cfg, OPTIONS, ballots);
    expect(t.winnerId).toBe("b");
    expect(t.options.find((o) => o.id === "a")!.value).toBe(2); // first-choice count
    expect(t.options.find((o) => o.id === "b")!.label).toContain("Winner");
  });
});

describe("tallyBallots — empty", () => {
  it("returns zeroed options with no ballots", () => {
    for (const style of BALLOT_STYLES) {
      const t = tallyBallots({ ballotStyle: style }, OPTIONS, []);
      expect(t.totalVotes).toBe(0);
      expect(t.options).toHaveLength(3);
      expect(t.options.every((o) => o.value === 0 && o.fraction === 0)).toBe(true);
    }
  });
});

describe("tallyWeightedBallots (P3)", () => {
  const cfg = (style: string, extra: Record<string, unknown> = {}) =>
    ({ ballotStyle: style, ...extra }) as Parameters<typeof tallyWeightedBallots>[0];

  it("weights multiple-choice counts and fractions by voter weight", () => {
    const tally = tallyWeightedBallots(cfg("multiple-choice"), ["a", "b"], [
      { ballot: { style: "multiple-choice", choice: "a" }, weight: 3 },
      { ballot: { style: "multiple-choice", choice: "b" }, weight: 1 },
    ]);
    expect(tally.totalVotes).toBe(2);
    expect(tally.totalWeight).toBe(4);
    expect(tally.options.find((o) => o.id === "a")!.value).toBe(3);
    expect(tally.options.find((o) => o.id === "a")!.fraction).toBeCloseTo(0.75, 5);
  });

  it("zero-weight ballots participate but move nothing", () => {
    const tally = tallyWeightedBallots(cfg("multiple-choice"), ["a", "b"], [
      { ballot: { style: "multiple-choice", choice: "a" }, weight: 0 },
      { ballot: { style: "multiple-choice", choice: "b" }, weight: 2 },
    ]);
    expect(tally.totalVotes).toBe(2);
    expect(tally.options.find((o) => o.id === "a")!.value).toBe(0);
    expect(tally.options.find((o) => o.id === "b")!.fraction).toBe(1);
  });

  it("score becomes a weight-weighted average", () => {
    const tally = tallyWeightedBallots(cfg("score", { scoreMax: 5 }), ["a"], [
      { ballot: { style: "score", scores: { a: 5 } }, weight: 3 },
      { ballot: { style: "score", scores: { a: 1 } }, weight: 1 },
    ]);
    // (5×3 + 1×1) / 4 = 4
    expect(tally.options[0].value).toBe(4);
  });

  it("ranked IRV majorities are weight majorities", () => {
    // Two light voters prefer a; one heavy voter prefers b → b wins outright.
    const tally = tallyWeightedBallots(cfg("ranked"), ["a", "b"], [
      { ballot: { style: "ranked", ranking: ["a", "b"] }, weight: 1 },
      { ballot: { style: "ranked", ranking: ["a", "b"] }, weight: 1 },
      { ballot: { style: "ranked", ranking: ["b", "a"] }, weight: 5 },
    ]);
    expect(tally.winnerId).toBe("b");
  });

  it("quadratic voice scales by weight on top of √credits", () => {
    const tally = tallyWeightedBallots(cfg("quadratic", { creditsPerVoter: 100 }), ["a"], [
      { ballot: { style: "quadratic", credits: { a: 100 } }, weight: 2 },
    ]);
    // 2 × √100 = 20
    expect(tally.options[0].value).toBe(20);
  });

  it("tallyBallots is exactly the all-weights-1 case", () => {
    const ballots = [
      { style: "approval", selections: ["a", "b"] },
      { style: "approval", selections: ["a"] },
    ] as Parameters<typeof tallyBallots>[2];
    const unweighted = tallyBallots(cfg("approval"), ["a", "b"], ballots);
    const weighted = tallyWeightedBallots(cfg("approval"), ["a", "b"], ballots.map((ballot) => ({ ballot, weight: 1 })));
    expect(unweighted).toEqual(weighted);
  });
});
