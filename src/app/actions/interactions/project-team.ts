"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { ensureLocalActorAgent } from "@/lib/federation/actor-projection";
import { getUserBadgeIds } from "@/lib/queries/resources";
import {
  evaluateJobClaimEligibility,
  deriveProjectTeam,
  JOB_CLAIM_DENIAL_MESSAGES,
  type JobClaimScope,
} from "@/lib/project-team";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/** Ledger interaction type used for project-team job claims (distinct from the
 * lightweight `job-application` interest signal). */
const JOB_CLAIM_INTERACTION = "job-claim";

/** Ledger interaction type marking a PENDING, approval-gated job claim. Kept as
 * an inactive (`is_active = false`) row with `reviewStatus = 'pending'` so it is
 * invisible to team/claim predicates until an admin approves it — mirroring the
 * group membership-request approval model. On approval the row is flipped to an
 * active `job-claim`. */
const JOB_CLAIM_REQUEST_INTERACTION = "job-claim-request";

/** Ledger interaction type marking a recorded job CONTRIBUTION on completion.
 * This is what surfaces a contributor as a stakeholder in the Stake tab — it is
 * NOT a badge award (badges are claim-time GATES, not completion rewards). */
const JOB_CONTRIBUTION_INTERACTION = "job-contribution";

/**
 * Counts the occupied slots on a job — active job-claims PLUS pending
 * approval-gated requests — optionally excluding one claimant. Pending requests
 * reserve a slot so an approval-gated job cannot be over-subscribed while
 * requests await review. */
async function countActiveJobClaims(
  jobId: string,
  excludeClaimantId?: string,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(DISTINCT subject_id) AS claim_count
    FROM ledger
    WHERE verb = 'join'
      AND metadata->>'targetId' = ${jobId}
      AND (
        (is_active = true AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION})
        OR (metadata->>'interactionType' = ${JOB_CLAIM_REQUEST_INTERACTION}
            AND COALESCE(metadata->>'reviewStatus', 'pending') = 'pending')
      )
      ${excludeClaimantId ? sql`AND subject_id <> ${excludeClaimantId}::uuid` : sql``}
  `)) as Array<Record<string, unknown>>;
  return Number(rows[0]?.claim_count ?? 0);
}

/** Returns whether the claimant already holds an active claim OR a pending
 * approval request on the job. */
async function claimantHasActiveClaim(
  jobId: string,
  claimantId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ledger
    WHERE subject_id = ${claimantId}::uuid
      AND verb = 'join'
      AND metadata->>'targetId' = ${jobId}
      AND (
        (is_active = true AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION})
        OR (metadata->>'interactionType' = ${JOB_CLAIM_REQUEST_INTERACTION}
            AND COALESCE(metadata->>'reviewStatus', 'pending') = 'pending')
      )
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/**
 * Claims a job for the current user, ENFORCING the J2 fit-scope gates: the job
 * must be open, the user must hold a required badge (if any), the job must have
 * an open assignee slot, and the user must not already hold a claim.
 *
 * On success a `job-claim` ledger edge is recorded; the set of agents holding
 * such edges across a project's jobs constitutes the project team.
 *
 * @param jobId UUID of the job resource to claim.
 * @returns ActionResult; on denial, the message reflects the precise reason.
 */
export async function claimJobAction(jobId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to claim a job." };
  if (!isUuid(jobId)) return { success: false, message: "Invalid job id." };

  // A federated remote-viewer member claiming a job writes a `job-claim`
  // ledger edge keyed on their id; project a local mirror first so the
  // subject_id FK holds even if this is their first local write (toybox
  // campaign 2026-07-11). No-op for the owner / local members / already-projected.
  await ensureLocalActorAgent(userId);

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [job] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.id, jobId),
        eq(resources.type, "job"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!job) return { success: false, message: "Job not found." };

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const groupId = job.ownerId;
  const requiredBadges = Array.isArray(meta.requiredBadges)
    ? meta.requiredBadges.filter((b): b is string => typeof b === "string")
    : [];
  const maxAssignees =
    typeof meta.maxAssignees === "number" ? meta.maxAssignees : null;
  const status = typeof meta.status === "string" ? meta.status : "open";

  // Creator-selected claim gates (set at job creation). Membership is no
  // longer creator-optional — it is the BASELINE (see evaluateJobClaimEligibility);
  // the stored claimGateMembership flag on older jobs is subsumed by it.
  const gateAdmin = meta.claimGateAdmin === true;
  const approvalRequired = meta.claimApprovalRequired === true;

  const scope: JobClaimScope = {
    claimable: status !== "closed" && status !== "cancelled" && status !== "filled",
    requiredBadges,
    maxAssignees,
    gateAdmin,
  };

  // Membership/admin are baseline facts now: every claim needs one of them.
  // isGroupAdmin cascades from ancestor groups via pathIds, so a parent-group
  // admin passes (and bypasses the badge gate) without a separate lookup.
  const { isGroupAdmin, isGroupMember } = await import("@/app/actions/group-admin");
  const [isAdmin, isMember, heldBadgeIds, activeClaimCount, alreadyClaimed] = await Promise.all([
    isGroupAdmin(userId, groupId),
    isGroupMember(userId, groupId),
    getUserBadgeIds(userId),
    countActiveJobClaims(jobId, userId),
    claimantHasActiveClaim(jobId, userId),
  ]);

  const eligibility = evaluateJobClaimEligibility(scope, {
    heldBadgeIds,
    activeClaimCount,
    alreadyClaimed,
    isMember,
    isAdmin,
  });
  if (!eligibility.eligible) {
    return { success: false, message: JOB_CLAIM_DENIAL_MESSAGES[eligibility.reason] };
  }

  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;

  const facadeResult = await federatedWrite(
    {
      type: approvalRequired ? "requestJobClaimAction" : "claimJobAction",
      actorId: userId,
      targetAgentId: groupId,
      payload: { jobId },
    },
    async () => {
      const values: NewLedgerEntry = approvalRequired
        ? ({
            subjectId: userId,
            verb: "join",
            objectId: jobId,
            objectType: "resource",
            resourceId: jobId,
            // Pending requests stay inactive + private so they are invisible to
            // team/claim predicates until an admin approves (mirrors the group
            // membership-request approval model).
            isActive: false,
            visibility: "private",
            metadata: {
              interactionType: JOB_CLAIM_REQUEST_INTERACTION,
              targetId: jobId,
              targetType: "job",
              projectId,
              groupId,
              reviewStatus: "pending",
              requestedAt: new Date().toISOString(),
            },
          } as NewLedgerEntry)
        : ({
            subjectId: userId,
            verb: "join",
            objectId: jobId,
            objectType: "resource",
            resourceId: jobId,
            isActive: true,
            metadata: {
              interactionType: JOB_CLAIM_INTERACTION,
              targetId: jobId,
              targetType: "job",
              projectId,
            },
          } as NewLedgerEntry);

      await db.insert(ledger).values(values);

      revalidatePath("/");
      revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);
      revalidatePath(`/groups/${groupId}`);
      return approvalRequired
        ? { success: true, message: "Claim submitted — awaiting approval.", pending: true }
        : ({ success: true, message: "Job claimed." } as ActionResult);
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to claim job." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: approvalRequired ? "job_claim_request" : "job_claim" },
  }).catch(() => {});

  return (
    facadeResult.data ??
    (approvalRequired
      ? { success: true, message: "Claim submitted — awaiting approval.", pending: true }
      : { success: true, message: "Job claimed." })
  );
}

/**
 * Records a job CONTRIBUTION when a claimed job is completed (EPIC J2,
 * corrected model 2026-06-23).
 *
 * Badges are claim-time GATES (you must hold a required badge to CLAIM a job),
 * NOT completion rewards — so completion does NOT mint a badge. Instead, it
 * writes a `complete` contribution ledger edge (subject = contributor, object =
 * the job) tagged `interactionType = 'job-contribution'`. This is the edge the
 * Stake tab reads to surface the contributor as a project stakeholder; a
 * recorded contribution CAN later factor into net allocation, but this action
 * MOVES NO MONEY (money-safety: distribution runs are gated separately).
 *
 * Authorization: only the job owner or a group-write-access holder may record a
 * contribution (it confers stakeholder standing). Duplicate records for the same
 * contributor+job are skipped idempotently.
 *
 * @param input.jobId UUID of the completed job.
 * @param input.contributorId Agent who completed the job and earns stakeholder standing.
 * @returns ActionResult; carries the contribution ledger `resourceId` (the job) on success.
 */
export async function recordJobContributionAction(input: {
  jobId: string;
  contributorId: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to record a contribution." };
  if (!isUuid(input.jobId) || !isUuid(input.contributorId)) {
    return { success: false, message: "Invalid job or contributor id." };
  }

  const [job] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.id, input.jobId),
        eq(resources.type, "job"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!job) return { success: false, message: "Job not found." };

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isOwner = job.ownerId === userId;
  const canRecord = isOwner ? true : await hasGroupWriteAccess(userId, job.ownerId);
  if (!canRecord) {
    return { success: false, message: "Only the job owner or a group admin can record a contribution." };
  }

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;

  // Idempotent: skip if a contribution edge already exists for this contributor+job.
  const existing = (await db.execute(sql`
    SELECT 1 FROM ledger
    WHERE subject_id = ${input.contributorId}::uuid
      AND verb = 'complete'
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CONTRIBUTION_INTERACTION}
      AND metadata->>'jobId' = ${input.jobId}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  if (existing.length > 0) {
    return { success: true, message: "Contribution already recorded.", resourceId: input.jobId };
  }

  await db.insert(ledger).values({
    verb: "complete",
    subjectId: input.contributorId,
    objectId: input.jobId,
    objectType: "resource",
    resourceId: input.jobId,
    isActive: true,
    metadata: {
      interactionType: JOB_CONTRIBUTION_INTERACTION,
      recordedBy: userId,
      recordedAt: new Date().toISOString(),
      source: "job-completion",
      jobId: input.jobId,
      projectId,
    },
  } as NewLedgerEntry);

  revalidatePath(`/jobs/${input.jobId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/groups/${job.ownerId}`);

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: input.jobId,
    actorId: userId,
    payload: { action: "record_job_contribution", contributorId: input.contributorId, jobId: input.jobId },
  }).catch(() => {});

  return { success: true, message: "Contribution recorded.", resourceId: input.jobId };
}

/**
 * Returns a group/project's recorded contributors — the unique agent ids with a
 * `job-contribution` ledger edge on the group's (or a specific project's) jobs.
 * Surfaces in the Stake tab as the contribution-derived stakeholder set.
 *
 * @param input.groupId The owning group/org agent id (matches job.ownerId).
 * @param input.projectId Optional: restrict to one project's jobs.
 * @returns Unique contributor agent ids with their contribution counts.
 */
export async function getRecordedContributions(input: {
  groupId: string;
  projectId?: string | null;
}): Promise<Array<{ contributorId: string; jobCount: number }>> {
  if (!isUuid(input.groupId)) return [];
  const projectFilter =
    input.projectId && isUuid(input.projectId)
      ? sql`AND l.metadata->>'projectId' = ${input.projectId}`
      : sql``;

  const rows = (await db.execute(sql`
    SELECT l.subject_id AS contributor_id, COUNT(*) AS job_count
    FROM ledger l
    JOIN resources j ON j.id = l.resource_id
    WHERE l.verb = 'complete'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = ${JOB_CONTRIBUTION_INTERACTION}
      AND j.type = 'job'
      AND j.deleted_at IS NULL
      AND j.owner_id = ${input.groupId}::uuid
      ${projectFilter}
    GROUP BY l.subject_id
    ORDER BY job_count DESC
  `)) as Array<Record<string, unknown>>;

  return rows
    .map((row) => ({
      contributorId: String(row.contributor_id ?? ""),
      jobCount: Number(row.job_count ?? 0),
    }))
    .filter((row) => row.contributorId.length > 0);
}

/**
 * Returns a project's team: the unique agent ids currently holding an active
 * job-claim on any of the project's jobs.
 *
 * Public read (no auth) so team rosters render on project boards; project
 * visibility is enforced by the page that calls this.
 *
 * @param projectId UUID of the project resource.
 * @returns Unique claimant agent ids forming the project team.
 */
export async function getProjectTeam(projectId: string): Promise<string[]> {
  if (!isUuid(projectId)) return [];

  const rows = (await db.execute(sql`
    SELECT l.subject_id AS claimant_id, l.metadata->>'targetId' AS job_id
    FROM ledger l
    JOIN resources j ON j.id = (l.metadata->>'targetId')::uuid
    WHERE l.verb = 'join'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION}
      AND j.type = 'job'
      AND j.deleted_at IS NULL
      AND j.metadata->>'projectId' = ${projectId}
    ORDER BY l.timestamp ASC
  `)) as Array<Record<string, unknown>>;

  return deriveProjectTeam(
    rows.map((row) => ({
      claimantId: String(row.claimant_id ?? ""),
      jobId: String(row.job_id ?? ""),
    })),
  );
}

/** A pending approval-gated job-claim request, for the admin review queue. */
export interface JobClaimRequestRecord {
  id: string;
  claimantId: string;
  jobId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  claimantName?: string | null;
  claimantUsername?: string | null;
  claimantAvatar?: string | null;
}

/**
 * Returns the pending approval-gated claim requests on a job. Admin-gated: only
 * the job owner or a group-write-access holder may view the queue.
 *
 * @param jobId UUID of the job resource.
 */
export async function fetchJobClaimRequests(
  jobId: string,
): Promise<{ success: boolean; error?: string; requests?: JobClaimRequestRecord[] }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: "Authentication required." };
  if (!isUuid(jobId)) return { success: false, error: "Invalid job id." };

  const [job] = await db
    .select({ id: resources.id, ownerId: resources.ownerId })
    .from(resources)
    .where(and(eq(resources.id, jobId), eq(resources.type, "job"), sql`${resources.deletedAt} IS NULL`))
    .limit(1);
  if (!job) return { success: false, error: "Job not found." };

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const canReview = job.ownerId === userId ? true : await hasGroupWriteAccess(userId, job.ownerId);
  if (!canReview) return { success: false, error: "Only group admins can review job claims." };

  const rows = (await db.execute(sql`
    SELECT l.id, l.subject_id AS claimant_id, l.timestamp AS requested_at,
           a.name AS claimant_name, a.x_handle AS claimant_username, a.image AS claimant_avatar
    FROM ledger l
    JOIN agents a ON a.id = l.subject_id
    WHERE l.verb = 'join'
      AND l.metadata->>'interactionType' = ${JOB_CLAIM_REQUEST_INTERACTION}
      AND l.metadata->>'targetId' = ${jobId}
      AND COALESCE(l.metadata->>'reviewStatus', 'pending') = 'pending'
    ORDER BY l.timestamp ASC
  `)) as Array<Record<string, unknown>>;

  const requests: JobClaimRequestRecord[] = rows.map((row) => ({
    id: String(row.id ?? ""),
    claimantId: String(row.claimant_id ?? ""),
    jobId,
    status: "pending" as const,
    requestedAt:
      row.requested_at instanceof Date
        ? row.requested_at.toISOString()
        : String(row.requested_at ?? ""),
    claimantName: (row.claimant_name as string | null) ?? null,
    claimantUsername: (row.claimant_username as string | null) ?? null,
    claimantAvatar: (row.claimant_avatar as string | null) ?? null,
  }));

  return { success: true, requests };
}

/**
 * Approves or rejects a pending job-claim request. Admin-gated. On approval the
 * pending row transitions in place to an active `job-claim` (it already reserved
 * a slot when requested, so approval cannot over-subscribe the job); on
 * rejection it is deactivated with `reviewStatus = 'rejected'`.
 *
 * @param requestId UUID of the pending job-claim-request ledger row.
 * @param decision `"approved"` or `"rejected"`.
 */
export async function reviewJobClaimRequest(
  requestId: string,
  decision: "approved" | "rejected",
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to review claims." };
  if (!isUuid(requestId)) return { success: false, message: "Invalid request id." };

  const [request] = await db
    .select({
      id: ledger.id,
      subjectId: ledger.subjectId,
      objectId: ledger.objectId,
      metadata: ledger.metadata,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.id, requestId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'interactionType' = ${JOB_CLAIM_REQUEST_INTERACTION}`,
      ),
    )
    .limit(1);
  if (!request) return { success: false, message: "Claim request not found." };

  const rmeta = (request.metadata ?? {}) as Record<string, unknown>;
  const jobId =
    typeof rmeta.targetId === "string" ? rmeta.targetId : request.objectId ?? null;
  if (!jobId) return { success: false, message: "Claim request is missing its job reference." };

  const [job] = await db
    .select({ ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, jobId), eq(resources.type, "job"), sql`${resources.deletedAt} IS NULL`))
    .limit(1);
  if (!job) return { success: false, message: "Job not found." };

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const canReview = job.ownerId === userId ? true : await hasGroupWriteAccess(userId, job.ownerId);
  if (!canReview) return { success: false, message: "Only group admins can review job claims." };

  const currentStatus = String(rmeta.reviewStatus ?? "pending");
  if (currentStatus !== "pending") {
    return { success: true, message: `This request was already ${currentStatus}.` };
  }

  const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
  const projectId =
    typeof jobMeta.projectId === "string"
      ? jobMeta.projectId
      : typeof rmeta.projectId === "string"
        ? rmeta.projectId
        : null;
  const reviewStamp = { reviewedBy: userId, reviewedAt: new Date().toISOString() };

  if (decision === "approved") {
    await db
      .update(ledger)
      .set({
        isActive: true,
        visibility: "public",
        metadata: {
          ...rmeta,
          interactionType: JOB_CLAIM_INTERACTION,
          reviewStatus: "approved",
          ...reviewStamp,
        },
      })
      .where(eq(ledger.id, requestId));
  } else {
    await db
      .update(ledger)
      .set({
        isActive: false,
        expiresAt: new Date(),
        metadata: { ...rmeta, reviewStatus: "rejected", ...reviewStamp },
      })
      .where(eq(ledger.id, requestId));
  }

  revalidatePath(`/jobs/${jobId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/groups/${job.ownerId}`);

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: "job_claim_review", decision, claimantId: request.subjectId },
  }).catch(() => {});

  return {
    success: true,
    message: decision === "approved" ? "Claim approved." : "Claim rejected.",
  };
}

/**
 * Returns the current user's claim state on a job for UI rendering:
 * `"claimed"` (active claim), `"pending"` (awaiting approval), or `"none"`.
 *
 * @param jobId UUID of the job resource.
 */
export async function getMyJobClaimStatus(
  jobId: string,
): Promise<"none" | "pending" | "claimed"> {
  const userId = await getCurrentUserId();
  if (!userId || !isUuid(jobId)) return "none";

  const rows = (await db.execute(sql`
    SELECT metadata->>'interactionType' AS interaction_type,
           COALESCE(metadata->>'reviewStatus', '') AS review_status,
           is_active
    FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND verb = 'join'
      AND metadata->>'targetId' = ${jobId}
      AND metadata->>'interactionType' IN (${JOB_CLAIM_INTERACTION}, ${JOB_CLAIM_REQUEST_INTERACTION})
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return "none";
  if (row.interaction_type === JOB_CLAIM_INTERACTION && row.is_active === true) return "claimed";
  if (
    row.interaction_type === JOB_CLAIM_REQUEST_INTERACTION &&
    String(row.review_status) === "pending"
  ) {
    return "pending";
  }
  return "none";
}

/** Everything the job-detail claim panel needs, resolved server-side in one call. */
export interface JobClaimPanelData {
  jobId: string;
  signedIn: boolean;
  status: "none" | "pending" | "claimed";
  approvalRequired: boolean;
  gateMembership: boolean;
  gateAdmin: boolean;
  isAdmin: boolean;
  claimantCount: number;
  maxAssignees: number | null;
  claimable: boolean;
  pendingRequests: JobClaimRequestRecord[];
}

/**
 * Resolves the full claim-panel state for a job: the viewer's claim status, the
 * job's gating config, whether the viewer is an admin of the owning group, the
 * current active-claimant count, and (for admins) the pending request queue.
 *
 * @param jobId UUID of the job resource.
 */
export async function getJobClaimPanelData(jobId: string): Promise<JobClaimPanelData | null> {
  if (!isUuid(jobId)) return null;

  const [job] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, jobId), eq(resources.type, "job"), sql`${resources.deletedAt} IS NULL`))
    .limit(1);
  if (!job) return null;

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const approvalRequired = meta.claimApprovalRequired === true;
  // Membership is the claim BASELINE (2026-07-10) — surfaced as always-on so
  // the panel's "members only" note reflects the enforced rule regardless of
  // what the job's stored legacy flag says.
  const gateMembership = true;
  const gateAdmin = meta.claimGateAdmin === true;
  const maxAssignees = typeof meta.maxAssignees === "number" ? meta.maxAssignees : null;
  const status = typeof meta.status === "string" ? meta.status : "open";
  const claimable = status !== "closed" && status !== "cancelled" && status !== "filled";

  const userId = await getCurrentUserId();

  // Active-claimant count (team size) — active job-claim edges only.
  const countRows = (await db.execute(sql`
    SELECT COUNT(DISTINCT subject_id) AS n
    FROM ledger
    WHERE verb = 'join' AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION}
      AND metadata->>'targetId' = ${jobId}
  `)) as Array<Record<string, unknown>>;
  const claimantCount = Number(countRows[0]?.n ?? 0);

  let myStatus: "none" | "pending" | "claimed" = "none";
  let isAdmin = false;
  let pendingRequests: JobClaimRequestRecord[] = [];

  if (userId) {
    const { isGroupAdmin } = await import("@/app/actions/group-admin");
    [myStatus, isAdmin] = await Promise.all([
      getMyJobClaimStatus(jobId),
      isGroupAdmin(userId, job.ownerId),
    ]);
    if (isAdmin) {
      const result = await fetchJobClaimRequests(jobId);
      pendingRequests = result.requests ?? [];
    }
  }

  return {
    jobId,
    signedIn: Boolean(userId),
    status: myStatus,
    approvalRequired,
    gateMembership,
    gateAdmin,
    isAdmin,
    claimantCount,
    maxAssignees,
    claimable,
    pendingRequests,
  };
}
