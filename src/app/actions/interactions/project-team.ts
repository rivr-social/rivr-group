"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
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

/** Ledger interaction type marking a recorded job CONTRIBUTION on completion.
 * This is what surfaces a contributor as a stakeholder in the Stake tab — it is
 * NOT a badge award (badges are claim-time GATES, not completion rewards). */
const JOB_CONTRIBUTION_INTERACTION = "job-contribution";

/** Counts the active job-claims on a job, optionally excluding one claimant. */
async function countActiveJobClaims(
  jobId: string,
  excludeClaimantId?: string,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(DISTINCT subject_id) AS claim_count
    FROM ledger
    WHERE verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION}
      AND metadata->>'targetId' = ${jobId}
      ${excludeClaimantId ? sql`AND subject_id <> ${excludeClaimantId}::uuid` : sql``}
  `)) as Array<Record<string, unknown>>;
  return Number(rows[0]?.claim_count ?? 0);
}

/** Returns whether the claimant already holds an active claim on the job. */
async function claimantHasActiveClaim(
  jobId: string,
  claimantId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ledger
    WHERE subject_id = ${claimantId}::uuid
      AND verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION}
      AND metadata->>'targetId' = ${jobId}
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
  const requiredBadges = Array.isArray(meta.requiredBadges)
    ? meta.requiredBadges.filter((b): b is string => typeof b === "string")
    : [];
  const maxAssignees =
    typeof meta.maxAssignees === "number" ? meta.maxAssignees : null;
  const status = typeof meta.status === "string" ? meta.status : "open";

  const scope: JobClaimScope = {
    claimable: status !== "closed" && status !== "cancelled" && status !== "filled",
    requiredBadges,
    maxAssignees,
  };

  const [heldBadgeIds, activeClaimCount, alreadyClaimed] = await Promise.all([
    getUserBadgeIds(userId),
    countActiveJobClaims(jobId, userId),
    claimantHasActiveClaim(jobId, userId),
  ]);

  const eligibility = evaluateJobClaimEligibility(scope, {
    heldBadgeIds,
    activeClaimCount,
    alreadyClaimed,
  });
  if (!eligibility.eligible) {
    return { success: false, message: JOB_CLAIM_DENIAL_MESSAGES[eligibility.reason] };
  }

  const facadeResult = await federatedWrite(
    {
      type: "claimJobAction",
      actorId: userId,
      targetAgentId: job.ownerId,
      payload: { jobId },
    },
    async () => {
      await db.insert(ledger).values({
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
          projectId: typeof meta.projectId === "string" ? meta.projectId : null,
        },
      } as NewLedgerEntry);

      const jobId2 = typeof meta.projectId === "string" ? meta.projectId : null;
      revalidatePath("/");
      revalidatePath(`/jobs/${jobId}`);
      if (jobId2) revalidatePath(`/groups/${job.ownerId}`);
      return { success: true, message: "Job claimed." } as ActionResult;
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
    payload: { action: "job_claim" },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Job claimed." };
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
