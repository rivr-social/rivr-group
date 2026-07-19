/**
 * @fileoverview Governance resolution (Phase 4 of the unified decision-model
 * scope — RECORD-ONLY per locked decision #6): quorum + threshold outcome
 * derivation, decision phases, and the board-role finalization math (locked
 * decision #4: an outcome is finalized when **2/3 of the org's board-role
 * holders** approve — not an automatic threshold, not a single role).
 *
 * NOTHING here executes: a finalized Decision records `outcome` (+ who
 * finalized it, when); users enact the decided change by hand via the
 * existing money/capability rails. PURE module — board-role storage and the
 * finalize action live in `app/actions/governance-resolution.ts`.
 */

/** The board-role seed set (scope §9 — the grant signatory roles + director). */
export const BOARD_ROLES = ["chair", "treasurer", "secretary", "director"] as const;

export type BoardRole = (typeof BOARD_ROLES)[number];

export const BOARD_ROLE_LABELS: Record<BoardRole, string> = {
  chair: "Chair",
  treasurer: "Treasurer",
  secretary: "Secretary",
  director: "Director",
};

export function isBoardRole(value: unknown): value is BoardRole {
  return typeof value === "string" && (BOARD_ROLES as readonly string[]).includes(value);
}

/**
 * Approvals required to finalize: ceil(2/3 × board-role holders). Zero board
 * holders → finalization impossible (returns Infinity) — an org must seat a
 * board before outcomes can be finalized.
 */
export function requiredFinalizeApprovals(boardHolderCount: number): number {
  if (!Number.isInteger(boardHolderCount) || boardHolderCount <= 0) return Infinity;
  return Math.ceil((2 * boardHolderCount) / 3);
}

/** Lifecycle phase of a governance item (derived, never stored as 'closed'). */
export type DecisionPhase = "active" | "closed" | "finalized";

export function decisionPhase(
  item: { status?: unknown; endDate?: unknown },
  now: Date = new Date(),
): DecisionPhase {
  if (String(item.status ?? "") === "finalized") return "finalized";
  const end = typeof item.endDate === "string" ? new Date(item.endDate) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() <= now.getTime()) return "closed";
  return "active";
}

export interface ProposalOutcome {
  kind: "proposal";
  /** Quorum satisfied (raw voter participation ≥ quorum). */
  quorumMet: boolean;
  /** Weighted yes fraction of the DECIDED pool (yes+no; abstain participates
   *  in quorum but not in the pass bar — the standard abstention model). */
  yesFraction: number;
  passed: boolean;
}

export interface PollOutcome {
  kind: "poll";
  /** The winning option id (tally winner, else highest value; null on a tie/empty). */
  winnerId: string | null;
}

export type DecisionOutcome = ProposalOutcome | PollOutcome;

/**
 * Derive a proposal's recorded outcome from its (weighted) vote counts.
 *
 * @param votes Weighted yes/no/abstain sums (P3).
 * @param totalVoters Raw voter participation (quorum input — weights never inflate it).
 * @param quorum Minimum raw voters (0 disables).
 * @param threshold Pass bar in percent (1..100) over the yes/(yes+no) weighted fraction.
 */
export function deriveProposalOutcome(params: {
  votes: { yes: number; no: number; abstain: number };
  totalVoters: number;
  quorum: number;
  threshold: number;
}): ProposalOutcome {
  const { votes, totalVoters, quorum, threshold } = params;
  const quorumMet = quorum <= 0 || totalVoters >= quorum;
  const decidedPool = votes.yes + votes.no;
  const yesFraction = decidedPool > 0 ? votes.yes / decidedPool : 0;
  const bar = Math.min(100, Math.max(1, Math.round(threshold))) / 100;
  const passed = quorumMet && decidedPool > 0 && yesFraction >= bar;
  return { kind: "proposal", quorumMet, yesFraction: Math.round(yesFraction * 10000) / 10000, passed };
}

/** Derive a poll's recorded outcome (winner) from its written-back tally. */
export function derivePollOutcome(item: {
  tally?: { winnerId?: string | null; options?: Array<{ id: string; value: number }> } | null;
  options?: Array<{ id: string; votes?: number }>;
}): PollOutcome {
  const tally = item.tally ?? null;
  if (tally?.winnerId) return { kind: "poll", winnerId: String(tally.winnerId) };
  const rows: Array<{ id: string; value: number }> =
    tally?.options?.map((o) => ({ id: o.id, value: o.value })) ??
    (item.options ?? []).map((o) => ({ id: String(o.id), value: Number(o.votes ?? 0) }));
  if (rows.length === 0) return { kind: "poll", winnerId: null };
  const max = Math.max(...rows.map((r) => r.value));
  if (max <= 0) return { kind: "poll", winnerId: null };
  const leaders = rows.filter((r) => r.value === max);
  // A tie records no winner — the humans decide what a tie means.
  return { kind: "poll", winnerId: leaders.length === 1 ? leaders[0].id : null };
}
