/**
 * Project teams via job-claim → fit scope → earn badge (EPIC J2).
 *
 * Purpose:
 * EPIC J2 specifies that a project's TEAM is not an explicit roster but an
 * emergent ReBAC/ABAC structure: a member becomes part of a project team by
 * CLAIMING a job whose scope they FIT (they hold the job's required badges and
 * the job still has an open assignee slot), and on completing the job they EARN
 * a configured badge. The set of members holding active job-claims on a
 * project's jobs IS that project's team.
 *
 * This module holds the PURE eligibility + team-derivation logic, separated from
 * the `@/db`-touching server action so the gating rules are unit-testable. The
 * action (`claimJobAction`) loads the job + the claimant's badges + the current
 * claim count from the database and feeds them to {@link evaluateJobClaimEligibility}.
 */

/** Reason a job claim was denied, for precise error reporting. */
export type JobClaimDenialReason =
  | 'job_not_claimable'
  | 'missing_required_badge'
  | 'no_open_slots'
  | 'already_claimed'
  | 'not_a_member'
  | 'not_an_admin';

/** Outcome of evaluating whether an agent may claim a job. */
export type JobClaimEligibility =
  | { eligible: true }
  | { eligible: false; reason: JobClaimDenialReason };

/** The fields of a job that gate claiming. */
export interface JobClaimScope {
  /** Whether the job is in a state that accepts claims at all. */
  claimable: boolean;
  /**
   * Badge resource ids the claimant must hold AT LEAST ONE of. An empty list
   * means the job is open to anyone (no badge gate).
   */
  requiredBadges: string[];
  /**
   * Maximum number of concurrent assignees. `null`/`undefined` means unlimited.
   */
  maxAssignees?: number | null;
  /**
   * Creator-selected claim gate: require active membership in the owning group
   * to claim. Default (undefined/false) = open to non-members.
   */
  gateMembership?: boolean;
  /**
   * Creator-selected claim gate: require group admin/moderator authority to
   * claim. Default (undefined/false) = no admin gate.
   */
  gateAdmin?: boolean;
}

/** The claimant-side facts needed to evaluate eligibility. */
export interface JobClaimContext {
  /** Badge resource ids the claimant currently holds. */
  heldBadgeIds: string[];
  /** Count of OTHER agents who currently hold an active claim on the job. */
  activeClaimCount: number;
  /** Whether THIS claimant already holds an active claim on the job. */
  alreadyClaimed: boolean;
  /** Whether the claimant holds an active membership in the owning group. */
  isMember?: boolean;
  /** Whether the claimant holds group admin/moderator authority. */
  isAdmin?: boolean;
}

/**
 * Returns whether the claimant satisfies the job's badge gate: holds at least
 * one of the required badges. An empty requirement list is always satisfied.
 */
export function meetsBadgeRequirement(
  requiredBadges: string[],
  heldBadgeIds: string[],
): boolean {
  if (requiredBadges.length === 0) return true;
  const held = new Set(heldBadgeIds);
  return requiredBadges.some((badgeId) => held.has(badgeId));
}

/**
 * Returns whether the job still has an open assignee slot. A `null`/`undefined`
 * or non-positive `maxAssignees` is treated as unlimited.
 */
export function hasOpenSlot(
  maxAssignees: number | null | undefined,
  activeClaimCount: number,
): boolean {
  if (maxAssignees === null || maxAssignees === undefined) return true;
  if (!Number.isFinite(maxAssignees) || maxAssignees <= 0) return true;
  return activeClaimCount < maxAssignees;
}

/**
 * Evaluates whether an agent may claim a job, applying the J2 gates in priority
 * order: the job must be claimable, the claimant must not already hold a claim,
 * must fit the badge scope, and a slot must be open.
 *
 * Returning the FIRST failing reason keeps error messaging deterministic.
 *
 * @param scope The job's claim-gating fields.
 * @param context The claimant's badges + current claim facts.
 * @returns Eligibility result with a precise denial reason when ineligible.
 */
export function evaluateJobClaimEligibility(
  scope: JobClaimScope,
  context: JobClaimContext,
): JobClaimEligibility {
  if (!scope.claimable) {
    return { eligible: false, reason: 'job_not_claimable' };
  }
  if (context.alreadyClaimed) {
    return { eligible: false, reason: 'already_claimed' };
  }
  if (scope.gateMembership && !context.isMember && !context.isAdmin) {
    return { eligible: false, reason: 'not_a_member' };
  }
  if (scope.gateAdmin && !context.isAdmin) {
    return { eligible: false, reason: 'not_an_admin' };
  }
  if (!meetsBadgeRequirement(scope.requiredBadges, context.heldBadgeIds)) {
    return { eligible: false, reason: 'missing_required_badge' };
  }
  if (!hasOpenSlot(scope.maxAssignees, context.activeClaimCount)) {
    return { eligible: false, reason: 'no_open_slots' };
  }
  return { eligible: true };
}

/** Human-readable messages for each denial reason, for UI/action surfacing. */
export const JOB_CLAIM_DENIAL_MESSAGES: Record<JobClaimDenialReason, string> = {
  job_not_claimable: 'This job is not open for claims.',
  missing_required_badge:
    'You do not hold a badge required to claim this job.',
  no_open_slots: 'This job has no open assignee slots remaining.',
  already_claimed: 'You have already claimed this job.',
  not_a_member: 'You must be a member of this group to claim this job.',
  not_an_admin: 'Only group admins can claim this job.',
};

/**
 * Derives a project's team — the unique set of agent ids currently holding an
 * active claim on any of the project's jobs — from a flat list of active
 * claim edges. Pure set-union over `claimantId`.
 *
 * @param claims Active job-claim edges across the project's jobs.
 * @returns Unique claimant agent ids, in first-seen order.
 */
export function deriveProjectTeam(
  claims: Array<{ claimantId: string; jobId: string }>,
): string[] {
  const seen = new Set<string>();
  const team: string[] = [];
  for (const claim of claims) {
    if (!claim.claimantId || seen.has(claim.claimantId)) continue;
    seen.add(claim.claimantId);
    team.push(claim.claimantId);
  }
  return team;
}
