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
 * Awards the badge a job is configured to confer (`metadata.awardBadgeId`) to a
 * claimant who has completed it. This is the EARN-A-BADGE half of J2's
 * claim → fit → earn loop. No-op (success) when the job confers no badge.
 *
 * Authorization: only the job owner or a group-write-access holder may award
 * (it moves a real credential). Duplicate awards are skipped idempotently.
 *
 * @param input.jobId UUID of the completed job.
 * @param input.recipientId Agent who completed the job and earns the badge.
 * @returns ActionResult; carries the awarded `resourceId` (badge) on success.
 */
export async function awardJobCompletionBadgeAction(input: {
  jobId: string;
  recipientId: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to award a badge." };
  if (!isUuid(input.jobId) || !isUuid(input.recipientId)) {
    return { success: false, message: "Invalid job or recipient id." };
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
  const canAward = isOwner ? true : await hasGroupWriteAccess(userId, job.ownerId);
  if (!canAward) {
    return { success: false, message: "Only the job owner or a group admin can award completion badges." };
  }

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const awardBadgeId = typeof meta.awardBadgeId === "string" ? meta.awardBadgeId : null;
  // No configured badge → the loop simply has no reward; not an error.
  if (!awardBadgeId) {
    return { success: true, message: "Job confers no completion badge." };
  }

  // Verify the badge resource exists.
  const [badge] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.id, awardBadgeId),
        eq(resources.type, "badge"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!badge) {
    return { success: false, message: "Configured completion badge no longer exists." };
  }

  // Idempotent: skip if the recipient already holds it.
  const existing = (await db.execute(sql`
    SELECT 1 FROM ledger
    WHERE subject_id = ${input.recipientId}::uuid
      AND resource_id = ${awardBadgeId}::uuid
      AND verb = 'assign'
      AND is_active = true
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  if (existing.length > 0) {
    return { success: true, message: "Recipient already holds this badge.", resourceId: awardBadgeId };
  }

  await db.insert(ledger).values({
    verb: "assign",
    subjectId: input.recipientId,
    objectId: awardBadgeId,
    objectType: "resource",
    resourceId: awardBadgeId,
    isActive: true,
    metadata: {
      assignedBy: userId,
      assignedAt: new Date().toISOString(),
      source: "job-completion",
      jobId: input.jobId,
    },
  } as NewLedgerEntry);

  revalidatePath(`/jobs/${input.jobId}`);
  revalidatePath("/badges");

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: awardBadgeId,
    actorId: userId,
    payload: { action: "award_completion_badge", recipientId: input.recipientId, jobId: input.jobId },
  }).catch(() => {});

  return { success: true, message: "Completion badge awarded.", resourceId: awardBadgeId };
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
