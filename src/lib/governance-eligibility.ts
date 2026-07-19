/**
 * @fileoverview Governance eligibility engine (Phase 2 of the unified
 * decision-model scope, `governance-decision-model-scope-2026-07-16.md` §3.3).
 *
 * A governance item (poll/proposal) carries an **eligibility gate** deciding
 * WHO may participate, generalizing the grant `whoCan*` vocabulary and the P0
 * members-only baseline into one enforced menu:
 *
 * - `public`        — any signed-in user (the pre-P0 behavior, now opt-in).
 * - `member`        — active members of the owning group (P0 baseline, DEFAULT).
 * - `badge-holder`  — holders of a governance badge (optionally one specific
 *                     badge; any of the group's governance badges when unset).
 * - `admin`         — group admins/managers only.
 * - `share-holder`  — members holding ≥ `minShares` shares in one of the org's
 *                     share classes (optionally one specific class).
 * - `abac`          — the actor must pass the live permission-policy engine
 *                     (`check(actor, "vote", groupId, "agent")`) — admins author
 *                     allow/deny policies on the group agent for the `vote` verb.
 *
 * The same gate shape also governs PROPOSE (who may create governance items),
 * stored at `groupMeta.governance.proposeGate` (default `admin` — the legacy
 * `hasGroupWriteAccess` behavior). Admins always retain propose authority; the
 * propose gate can only WIDEN it. Vote gates define the electorate exactly —
 * admins do NOT bypass them.
 *
 * FINALIZE authority is intentionally NOT configured here: decision #4
 * (2026-07-16) locks finalization to 2/3 of board-role holders, which lands
 * with the P4 resolution layer and its board-role primitive.
 *
 * This module is PURE (no imports) so the tally/enforcement logic is unit
 * testable and identical across repos. Fact gathering (DB lookups) lives in
 * `governance-eligibility.server.ts`.
 */

export const ELIGIBILITY_KINDS = [
  "public",
  "member",
  "badge-holder",
  "admin",
  "share-holder",
  "abac",
] as const;

export type EligibilityKind = (typeof ELIGIBILITY_KINDS)[number];

/** A normalized eligibility gate as stored on a governance item / group meta. */
export interface EligibilityGate {
  kind: EligibilityKind;
  /** badge-holder: a specific governance badge; any governance badge when unset. */
  badgeId?: string;
  /** share-holder: a specific share class; any of the org's classes when unset. */
  shareClassId?: string;
  /** share-holder: minimum shares held (default {@link DEFAULT_MIN_SHARES}). */
  minShares?: number;
}

/** Everything the pure evaluator needs to know about the actor. */
export interface EligibilityFacts {
  isAuthenticated: boolean;
  isMember: boolean;
  isAdmin: boolean;
  /** Governance-badge ids (of the owning group) the actor actively holds. */
  heldBadgeIds: readonly string[];
  /** classId → shares actively held, for the owning org's share classes only. */
  shareHoldings: Readonly<Record<string, number>>;
  /** Verdict of the permission-policy engine for `vote` on the group agent. */
  abacAllowed: boolean;
}

/** Which fact families a gate needs — lets the server fetch only those. */
export interface EligibilityFactNeeds {
  member: boolean;
  admin: boolean;
  badges: boolean;
  shares: boolean;
  abac: boolean;
}

/** The P0 baseline: voting is a member act unless the item widens/narrows it. */
export const DEFAULT_VOTE_GATE: EligibilityGate = { kind: "member" };
/** The legacy create authority: admins/managers (`hasGroupWriteAccess`). */
export const DEFAULT_PROPOSE_GATE: EligibilityGate = { kind: "admin" };
/** share-holder gates require at least this many shares when unspecified. */
export const DEFAULT_MIN_SHARES = 1;

export const ELIGIBILITY_KIND_LABELS: Record<EligibilityKind, string> = {
  public: "Anyone signed in",
  member: "Group members",
  "badge-holder": "Badge holders",
  admin: "Admins only",
  "share-holder": "Share holders",
  abac: "Custom policy",
};

export const ELIGIBILITY_KIND_DESCRIPTIONS: Record<EligibilityKind, string> = {
  public: "Any signed-in user may vote, including non-members.",
  member: "Active members of this group may vote.",
  "badge-holder": "Only holders of a governance badge may vote.",
  admin: "Only group admins and managers may vote.",
  "share-holder": "Only members holding shares in a share class may vote.",
  abac: "Voters must be allowed by this group's permission policies (verb: vote).",
};

/** Propose-phrased twins of the vote descriptions, for the admin
 *  "Who can propose" setting (admins always retain propose authority). */
export const ELIGIBILITY_KIND_PROPOSE_DESCRIPTIONS: Record<EligibilityKind, string> = {
  public: "Any signed-in user may create governance items, including non-members.",
  member: "Active members of this group may create governance items.",
  "badge-holder": "Only holders of a governance badge may create governance items.",
  admin: "Only group admins and managers may create governance items.",
  "share-holder": "Only members holding shares in a share class may create governance items.",
  abac: "Proposers must be allowed by this group's permission policies (verb: vote).",
};

export function isEligibilityKind(value: unknown): value is EligibilityKind {
  return typeof value === "string" && (ELIGIBILITY_KINDS as readonly string[]).includes(value);
}

/**
 * Normalize a raw (stored or client-supplied) gate into a valid
 * {@link EligibilityGate}, falling back to `fallback` when the shape is
 * missing/unknown. Unknown kinds fall back rather than throw so legacy items
 * and forward-written data keep evaluating safely.
 */
export function parseEligibilityGate(
  raw: unknown,
  fallback: EligibilityGate = DEFAULT_VOTE_GATE,
): EligibilityGate {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const rec = raw as Record<string, unknown>;
  if (!isEligibilityKind(rec.kind)) return { ...fallback };
  const gate: EligibilityGate = { kind: rec.kind };
  if (rec.kind === "badge-holder" && typeof rec.badgeId === "string" && rec.badgeId.trim()) {
    gate.badgeId = rec.badgeId.trim();
  }
  if (rec.kind === "share-holder") {
    if (typeof rec.shareClassId === "string" && rec.shareClassId.trim()) {
      gate.shareClassId = rec.shareClassId.trim();
    }
    const minShares = Number(rec.minShares);
    gate.minShares =
      Number.isInteger(minShares) && minShares >= 1 ? minShares : DEFAULT_MIN_SHARES;
  }
  return gate;
}

/** Which facts {@link evaluateEligibilityGate} will read for this gate. */
export function gateFactNeeds(gate: EligibilityGate): EligibilityFactNeeds {
  return {
    member: gate.kind === "member" || gate.kind === "share-holder",
    admin: gate.kind === "admin",
    badges: gate.kind === "badge-holder",
    shares: gate.kind === "share-holder",
    abac: gate.kind === "abac",
  };
}

/** Union of {@link gateFactNeeds} across several gates (page-level batching). */
export function combinedFactNeeds(gates: readonly EligibilityGate[]): EligibilityFactNeeds {
  const needs: EligibilityFactNeeds = {
    member: false,
    admin: false,
    badges: false,
    shares: false,
    abac: false,
  };
  for (const gate of gates) {
    const n = gateFactNeeds(gate);
    needs.member = needs.member || n.member;
    needs.admin = needs.admin || n.admin;
    needs.badges = needs.badges || n.badges;
    needs.shares = needs.shares || n.shares;
    needs.abac = needs.abac || n.abac;
  }
  return needs;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Human-readable reason when ineligible (shown next to a disabled Vote). */
  reason?: string;
}

/**
 * Evaluate a gate against the actor's facts. Pure — the caller resolves facts.
 * Every kind (including `public`) requires authentication: anonymous actors
 * are never part of any electorate.
 */
export function evaluateEligibilityGate(
  gate: EligibilityGate,
  facts: EligibilityFacts,
): EligibilityVerdict {
  if (!facts.isAuthenticated) {
    return { eligible: false, reason: "You must be signed in to vote." };
  }
  switch (gate.kind) {
    case "public":
      return { eligible: true };
    case "member":
      return facts.isMember
        ? { eligible: true }
        : { eligible: false, reason: "Only group members can vote on this item." };
    case "admin":
      return facts.isAdmin
        ? { eligible: true }
        : { eligible: false, reason: "Only group admins can vote on this item." };
    case "badge-holder": {
      const holds = gate.badgeId
        ? facts.heldBadgeIds.includes(gate.badgeId)
        : facts.heldBadgeIds.length > 0;
      return holds
        ? { eligible: true }
        : { eligible: false, reason: "Only governance badge holders can vote on this item." };
    }
    case "share-holder": {
      if (!facts.isMember) {
        return { eligible: false, reason: "Only group members can vote on this item." };
      }
      const minShares = gate.minShares ?? DEFAULT_MIN_SHARES;
      const held = gate.shareClassId
        ? (facts.shareHoldings[gate.shareClassId] ?? 0)
        : Math.max(0, ...Object.values(facts.shareHoldings));
      return held >= minShares
        ? { eligible: true }
        : {
            eligible: false,
            reason:
              minShares > 1
                ? `Only holders of at least ${minShares} shares can vote on this item.`
                : "Only share holders can vote on this item.",
          };
    }
    case "abac":
      return facts.abacAllowed
        ? { eligible: true }
        : { eligible: false, reason: "This group's voting policy does not allow you to vote on this item." };
  }
}

/**
 * Human chip label for a gate ("Badge holders — Land Steward",
 * "Share holders — Stewards, min 10"). `names` resolves referenced ids.
 */
export function describeEligibilityGate(
  gate: EligibilityGate,
  names?: { badgeName?: string; shareClassName?: string },
): string {
  const base = ELIGIBILITY_KIND_LABELS[gate.kind];
  if (gate.kind === "badge-holder" && gate.badgeId) {
    return names?.badgeName ? `${base} — ${names.badgeName}` : base;
  }
  if (gate.kind === "share-holder") {
    const parts: string[] = [];
    if (gate.shareClassId) parts.push(names?.shareClassName ?? "class");
    const minShares = gate.minShares ?? DEFAULT_MIN_SHARES;
    if (minShares > 1) parts.push(`min ${minShares}`);
    return parts.length > 0 ? `${base} — ${parts.join(", ")}` : base;
  }
  return base;
}
