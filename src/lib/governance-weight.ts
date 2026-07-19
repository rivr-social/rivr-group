/**
 * @fileoverview Governance vote-weight functions (Phase 3 of the unified
 * decision-model scope, `governance-decision-model-scope-2026-07-16.md` §3.4 +
 * §5 + locked decisions #1/#2). A Decision (poll/proposal) chooses HOW MUCH
 * each eligible voice counts:
 *
 * - `equal`         — 1 person 1 vote (the default, decision #2).
 * - `stake`         — task points earned across the org subtree (the SAME
 *                     weights net-distribution pays by): "those who did the
 *                     work decide". Zero-point members participate at weight 0.
 * - `voting-shares` — share-class governance weight via the class `voteBps`
 *                     dimension (decision #1: SEPARATE from the profit
 *                     `netBps`): a member's weight = Σ over the org's classes
 *                     of voteBps × (memberShares / classTotalShares).
 * - `badge-weight`  — the governance badge's `votingWeight` (the rail
 *                     scaffolded pre-P1, now surfaced): a named badge's weight
 *                     if held, else the highest-weighted governance badge the
 *                     voter holds; non-holders participate at weight 0.
 *
 * The org sets a DEFAULT weight in governance settings
 * (`groupMeta.governance.defaultWeight`, ships as `equal`); each poll/proposal
 * may override it at creation (decision #2). The voter's weight is resolved
 * server-side AT CAST TIME and frozen onto the vote ledger row
 * (`metadata.voteWeight`), so tallies recompute deterministically from stored
 * rows; a re-vote refreshes that voter's weight. Zero-weight votes still count
 * toward participation (quorum) but move no bars.
 *
 * PURE module — fact gathering lives in `governance-weight.server.ts`.
 */

export const WEIGHT_KINDS = ["equal", "stake", "voting-shares", "badge-weight"] as const;

export type WeightKind = (typeof WEIGHT_KINDS)[number];

/** A normalized weight configuration as stored on a governance item / group meta. */
export interface WeightConfig {
  kind: WeightKind;
  /** badge-weight: a specific governance badge; the voter's highest-weighted
   *  held badge when unset. */
  badgeId?: string;
}

export const DEFAULT_WEIGHT_CONFIG: WeightConfig = { kind: "equal" };

export const WEIGHT_KIND_LABELS: Record<WeightKind, string> = {
  equal: "Equal (1 person, 1 vote)",
  stake: "Stake (task points)",
  "voting-shares": "Voting shares",
  "badge-weight": "Badge weight",
};

/** Short chip labels for cards (the equal default renders no chip). */
export const WEIGHT_KIND_CHIP_LABELS: Record<WeightKind, string> = {
  equal: "1p1v",
  stake: "Stake-weighted",
  "voting-shares": "Share-weighted",
  "badge-weight": "Badge-weighted",
};

export const WEIGHT_KIND_DESCRIPTIONS: Record<WeightKind, string> = {
  equal: "Every eligible voter counts the same.",
  stake: "Votes are weighted by task points earned across the org — those who did the work decide.",
  "voting-shares": "Votes are weighted by share-class voting power (the classes' voting basis points).",
  "badge-weight": "Votes are weighted by the governance badge's voting weight; non-holders vote at weight 0.",
};

export function isWeightKind(value: unknown): value is WeightKind {
  return typeof value === "string" && (WEIGHT_KINDS as readonly string[]).includes(value);
}

/**
 * Normalize a raw (stored or client-supplied) weight config, falling back to
 * `fallback` on unknown shapes so legacy items keep evaluating as 1p1v.
 */
export function parseWeightConfig(
  raw: unknown,
  fallback: WeightConfig = DEFAULT_WEIGHT_CONFIG,
): WeightConfig {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const rec = raw as Record<string, unknown>;
  if (!isWeightKind(rec.kind)) return { ...fallback };
  const config: WeightConfig = { kind: rec.kind };
  if (rec.kind === "badge-weight" && typeof rec.badgeId === "string" && rec.badgeId.trim()) {
    config.badgeId = rec.badgeId.trim();
  }
  return config;
}

/** Chip/label text, resolving a referenced badge name when provided. */
export function describeWeightConfig(
  config: WeightConfig,
  names?: { badgeName?: string },
): string {
  const base = WEIGHT_KIND_CHIP_LABELS[config.kind];
  if (config.kind === "badge-weight" && config.badgeId && names?.badgeName) {
    return `${base} — ${names.badgeName}`;
  }
  return base;
}

/** Normalize a resolved weight: finite, non-negative, 2-decimal stable. */
export function normalizeWeight(value: unknown): number {
  const v = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v * 100) / 100;
}
