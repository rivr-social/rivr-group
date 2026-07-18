/**
 * @fileoverview Governance ballot styles — the six ballot styles for polls
 * (P1 of the unified decision model, `governance-decision-model-scope-2026-07-16.md`
 * §4). PURE and dependency-free so it is identical across repos, usable on both
 * the server (vote validation + tally write-back in `castGovernanceVoteAction`)
 * and the client (input widgets + result rendering in the governance tab), and
 * fully unit-testable.
 *
 * A poll carries a `ballotStyle` discriminator (default `"multiple-choice"` —
 * the legacy behavior) plus optional per-style config (`scoreMax` for
 * score/rate-rank, `creditsPerVoter` for quadratic). Each cast stores a
 * normalized {@link Ballot} in the vote ledger row's `metadata.ballot`; the
 * tally recomputes from all ACTIVE ballots via {@link tallyBallots}.
 *
 * Quadratic credits are per-Decision + creator-set (scope §8 decision #3): the
 * voter receives `creditsPerVoter` credits to spend across options; an option's
 * voice is Σ√(credits) (spending c credits on an option buys √c votes), which is
 * the anti-whale quadratic-voting curve.
 */

export const BALLOT_STYLES = [
  "multiple-choice",
  "approval",
  "score",
  "ranked",
  "rate-rank",
  "quadratic",
] as const;

export type BallotStyle = (typeof BALLOT_STYLES)[number];

export const DEFAULT_BALLOT_STYLE: BallotStyle = "multiple-choice";

/** Score/importance sliders run 0..MAX. */
export const DEFAULT_SCORE_MAX = 5;
export const DEFAULT_IMPORTANCE_MAX = 5;
/** Default per-voter quadratic credit budget. */
export const DEFAULT_CREDITS_PER_VOTER = 100;
export const MAX_SCORE_MAX = 10;
export const MAX_CREDITS_PER_VOTER = 10_000;

export const BALLOT_STYLE_LABELS: Record<BallotStyle, string> = {
  "multiple-choice": "Multiple choice",
  approval: "Approval",
  score: "Score",
  ranked: "Ranked choice",
  "rate-rank": "Rate + Rank",
  quadratic: "Quadratic",
};

export const BALLOT_STYLE_DESCRIPTIONS: Record<BallotStyle, string> = {
  "multiple-choice": "Pick one option. Highest count wins.",
  approval: "Pick any options you approve of. Counted per option.",
  score: "Rate each option on a slider. Averaged across voters.",
  ranked: "Rank the options. Resolved by instant-runoff to a single winner.",
  "rate-rank": "Score each option and mark how much it matters. Salience-weighted.",
  quadratic: "Spend a credit budget across options. Voice grows as √credits (anti-whale).",
};

export function isBallotStyle(value: unknown): value is BallotStyle {
  return typeof value === "string" && (BALLOT_STYLES as readonly string[]).includes(value);
}

/** Per-poll ballot configuration, stored alongside the poll in group metadata. */
export interface PollBallotConfig {
  ballotStyle: BallotStyle;
  /** score + rate-rank: max slider value (0..scoreMax). */
  scoreMax?: number;
  /** quadratic: credits each voter may spend. */
  creditsPerVoter?: number;
}

/** A normalized per-voter ballot, stored in the vote ledger row's metadata. */
export type Ballot =
  | { style: "multiple-choice"; choice: string }
  | { style: "approval"; selections: string[] }
  | { style: "score"; scores: Record<string, number> }
  | { style: "ranked"; ranking: string[] }
  | { style: "rate-rank"; ratings: Record<string, { score: number; importance: number }> }
  | { style: "quadratic"; credits: Record<string, number> };

export interface ValidateOk {
  ok: true;
  ballot: Ballot;
}
export interface ValidateErr {
  ok: false;
  error: string;
}
export type ValidateResult = ValidateOk | ValidateErr;

function clampInt(n: unknown, lo: number, hi: number): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v);
  if (r < lo || r > hi) return null;
  return r;
}

export function resolveScoreMax(config: PollBallotConfig): number {
  const v = config.scoreMax;
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= MAX_SCORE_MAX) return Math.round(v);
  return DEFAULT_SCORE_MAX;
}

export function resolveCreditsPerVoter(config: PollBallotConfig): number {
  const v = config.creditsPerVoter;
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= MAX_CREDITS_PER_VOTER) return Math.round(v);
  return DEFAULT_CREDITS_PER_VOTER;
}

/**
 * Validate + normalize a raw ballot payload against the poll's style, config,
 * and the set of valid option ids. Returns the normalized {@link Ballot} on
 * success. Never throws.
 */
export function validateBallot(
  config: PollBallotConfig,
  optionIds: string[],
  raw: unknown,
): ValidateResult {
  const style = config.ballotStyle;
  const valid = new Set(optionIds);
  if (valid.size === 0) return { ok: false, error: "Poll has no options" };
  const r = (raw ?? {}) as Record<string, unknown>;

  switch (style) {
    case "multiple-choice": {
      // Accept either { choice } or a bare string (legacy `vote`).
      const choice = typeof raw === "string" ? raw : typeof r.choice === "string" ? r.choice : "";
      if (!valid.has(choice)) return { ok: false, error: "Select one of the poll options" };
      return { ok: true, ballot: { style, choice } };
    }
    case "approval": {
      const rawSel = Array.isArray(r.selections) ? r.selections : [];
      const selections = [...new Set(rawSel.map(String))].filter((id) => valid.has(id));
      if (selections.length === 0) return { ok: false, error: "Approve at least one option" };
      return { ok: true, ballot: { style, selections } };
    }
    case "score": {
      const max = resolveScoreMax(config);
      const src = (r.scores ?? {}) as Record<string, unknown>;
      const scores: Record<string, number> = {};
      for (const id of optionIds) {
        if (id in src) {
          const s = clampInt(src[id], 0, max);
          if (s === null) return { ok: false, error: `Score for each option must be 0–${max}` };
          scores[id] = s;
        }
      }
      if (Object.keys(scores).length === 0) return { ok: false, error: "Score at least one option" };
      return { ok: true, ballot: { style, scores } };
    }
    case "ranked": {
      const rawRank = Array.isArray(r.ranking) ? r.ranking.map(String) : [];
      const seen = new Set<string>();
      const ranking: string[] = [];
      for (const id of rawRank) {
        if (valid.has(id) && !seen.has(id)) {
          seen.add(id);
          ranking.push(id);
        }
      }
      if (ranking.length === 0) return { ok: false, error: "Rank at least one option" };
      return { ok: true, ballot: { style, ranking } };
    }
    case "rate-rank": {
      const max = resolveScoreMax(config);
      const impMax = DEFAULT_IMPORTANCE_MAX;
      const src = (r.ratings ?? {}) as Record<string, unknown>;
      const ratings: Record<string, { score: number; importance: number }> = {};
      for (const id of optionIds) {
        const entry = src[id];
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          const score = clampInt(e.score, 0, max);
          const importance = clampInt(e.importance, 0, impMax);
          if (score === null) return { ok: false, error: `Score must be 0–${max}` };
          if (importance === null) return { ok: false, error: `Importance must be 0–${impMax}` };
          ratings[id] = { score, importance };
        }
      }
      if (Object.keys(ratings).length === 0) return { ok: false, error: "Rate at least one option" };
      return { ok: true, ballot: { style, ratings } };
    }
    case "quadratic": {
      const budget = resolveCreditsPerVoter(config);
      const src = (r.credits ?? {}) as Record<string, unknown>;
      const credits: Record<string, number> = {};
      let spent = 0;
      for (const id of optionIds) {
        if (id in src) {
          const c = clampInt(src[id], 0, budget);
          if (c === null) return { ok: false, error: `Credits must be 0–${budget}` };
          if (c > 0) {
            credits[id] = c;
            spent += c;
          }
        }
      }
      if (spent === 0) return { ok: false, error: "Spend at least one credit" };
      if (spent > budget) return { ok: false, error: `You may spend at most ${budget} credits (spent ${spent})` };
      return { ok: true, ballot: { style, credits } };
    }
    default:
      return { ok: false, error: "Unsupported ballot style" };
  }
}

/** Coerce a stored ledger `metadata.ballot` (or legacy `vote`) into a Ballot. */
export function ballotFromStored(style: BallotStyle, storedBallot: unknown, legacyVote: unknown): Ballot | null {
  if (storedBallot && typeof storedBallot === "object") {
    const b = storedBallot as Record<string, unknown>;
    // Trust the style discriminator on the stored object when present.
    if (isBallotStyle(b.style)) return b as unknown as Ballot;
  }
  // Legacy rows (pre-P1) stored only `metadata.vote` = the chosen option id.
  if (style === "multiple-choice" && typeof legacyVote === "string") {
    return { style, choice: legacyVote };
  }
  return null;
}

export interface TallyOption {
  id: string;
  /** Per-style headline number: choice/approval count, avg score, first-choice
   *  count (ranked), salience-weighted score (rate-rank), or Σ√credits (quadratic). */
  value: number;
  /** 0..1 bar fill fraction. */
  fraction: number;
  /** Short human label for the row (e.g. "62% (13)", "4.2 / 5", "12.4 votes"). */
  label: string;
  /** Raw participant count contributing to this option (voters who engaged it). */
  count: number;
}

export interface PollTally {
  style: BallotStyle;
  /** Number of distinct ballots cast. */
  totalVotes: number;
  options: TallyOption[];
  /** Single-winner styles (ranked) resolve a winner. */
  winnerId?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Instant-runoff (ranked-choice) winner. Eliminates the lowest first-choice
 * option each round and redistributes to the next still-standing preference
 * until an option holds a majority of active ballots (or one option remains).
 * Deterministic tie-break: lowest option id is eliminated first.
 */
export function instantRunoffWinner(ballots: string[][], optionIds: string[]): string | undefined {
  let remaining = new Set(optionIds);
  const active = ballots.map((b) => b.filter((id) => optionIds.includes(id))).filter((b) => b.length > 0);
  if (active.length === 0) return undefined;

  while (remaining.size > 1) {
    const counts = new Map<string, number>();
    for (const id of remaining) counts.set(id, 0);
    for (const b of active) {
      const top = b.find((id) => remaining.has(id));
      if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const totalActive = [...counts.values()].reduce((a, c) => a + c, 0);
    let leaderId: string | undefined;
    let leaderCount = -1;
    let loserId: string | undefined;
    let loserCount = Infinity;
    for (const [id, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (c > leaderCount) {
        leaderCount = c;
        leaderId = id;
      }
      if (c < loserCount) {
        loserCount = c;
        loserId = id;
      }
    }
    if (leaderId && leaderCount * 2 > totalActive) return leaderId;
    if (!loserId) break;
    remaining.delete(loserId);
  }
  return remaining.size === 1 ? [...remaining][0] : undefined;
}

/**
 * Aggregate active ballots into a per-style {@link PollTally}. The single source
 * of truth for both the metadata write-back (server) and result rendering.
 */
export function tallyBallots(
  config: PollBallotConfig,
  optionIds: string[],
  ballots: Ballot[],
): PollTally {
  const style = config.ballotStyle;
  const totalVotes = ballots.length;
  const base = (): TallyOption[] => optionIds.map((id) => ({ id, value: 0, fraction: 0, label: "", count: 0 }));
  const byId = new Map<string, TallyOption>();
  const opts = base();
  for (const o of opts) byId.set(o.id, o);

  switch (style) {
    case "multiple-choice":
    case "approval": {
      for (const b of ballots) {
        const chosen = b.style === "multiple-choice" ? [b.choice] : b.style === "approval" ? b.selections : [];
        for (const id of chosen) {
          const o = byId.get(id);
          if (o) {
            o.value += 1;
            o.count += 1;
          }
        }
      }
      for (const o of opts) {
        o.fraction = totalVotes > 0 ? o.value / totalVotes : 0;
        o.label = `${pct(o.fraction)} (${o.value})`;
      }
      break;
    }
    case "score": {
      const max = resolveScoreMax(config);
      const sum = new Map<string, number>();
      for (const b of ballots) {
        if (b.style !== "score") continue;
        for (const [id, s] of Object.entries(b.scores)) {
          const o = byId.get(id);
          if (!o) continue;
          sum.set(id, (sum.get(id) ?? 0) + s);
          o.count += 1;
        }
      }
      for (const o of opts) {
        const avg = o.count > 0 ? (sum.get(o.id) ?? 0) / o.count : 0;
        o.value = Math.round(avg * 100) / 100;
        o.fraction = max > 0 ? avg / max : 0;
        o.label = `${o.value.toFixed(1)} / ${max} (${o.count})`;
      }
      break;
    }
    case "ranked": {
      const rankings = ballots.filter((b): b is Extract<Ballot, { style: "ranked" }> => b.style === "ranked").map((b) => b.ranking);
      const winnerId = instantRunoffWinner(rankings, optionIds);
      for (const r of rankings) {
        const top = r.find((id) => byId.has(id));
        if (top) {
          const o = byId.get(top)!;
          o.value += 1;
          o.count += 1;
        }
      }
      for (const o of opts) {
        o.fraction = totalVotes > 0 ? o.value / totalVotes : 0;
        o.label = o.id === winnerId ? `Winner · 1st: ${o.value}` : `1st choice: ${o.value}`;
      }
      return { style, totalVotes, options: opts, winnerId };
    }
    case "rate-rank": {
      const max = resolveScoreMax(config);
      const num = new Map<string, number>();
      const den = new Map<string, number>();
      for (const b of ballots) {
        if (b.style !== "rate-rank") continue;
        for (const [id, { score, importance }] of Object.entries(b.ratings)) {
          const o = byId.get(id);
          if (!o) continue;
          num.set(id, (num.get(id) ?? 0) + score * importance);
          den.set(id, (den.get(id) ?? 0) + importance);
          o.count += 1;
        }
      }
      for (const o of opts) {
        const d = den.get(o.id) ?? 0;
        const weighted = d > 0 ? (num.get(o.id) ?? 0) / d : 0;
        o.value = Math.round(weighted * 100) / 100;
        o.fraction = max > 0 ? weighted / max : 0;
        o.label = `${o.value.toFixed(1)} / ${max} (${o.count})`;
      }
      break;
    }
    case "quadratic": {
      // Voice per option = Σ_voters √(credits spent on it).
      const voice = new Map<string, number>();
      for (const b of ballots) {
        if (b.style !== "quadratic") continue;
        for (const [id, c] of Object.entries(b.credits)) {
          const o = byId.get(id);
          if (!o || c <= 0) continue;
          voice.set(id, (voice.get(id) ?? 0) + Math.sqrt(c));
          o.count += 1;
        }
      }
      const totalVoice = [...voice.values()].reduce((a, v) => a + v, 0);
      for (const o of opts) {
        const v = voice.get(o.id) ?? 0;
        o.value = Math.round(v * 100) / 100;
        o.fraction = totalVoice > 0 ? v / totalVoice : 0;
        o.label = `${o.value.toFixed(1)} votes (${o.count})`;
      }
      break;
    }
  }

  return { style, totalVotes, options: opts };
}
