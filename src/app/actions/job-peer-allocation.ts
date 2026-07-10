"use server";

/**
 * Job-level peer point allocation + "claim complete" (2026-07-10).
 *
 * Multi-assignee jobs carrying a job-level point pool (`metadata.points`)
 * split it by MUTUAL assessment: every assignee sets slider weights over the
 * other assignees (`setJobPointShareInputAction` → metadata.pointShareInputs)
 * and `markJobDoneAction` converts the aggregate into integer points via
 * `allocatePointsByShares` (equal split until inputs exist).
 *
 * "Claim complete" (`claimJobFinishedAction`) is the worker's job-level
 * "claimed finished" REA event — it carries the voucher-style self-ratings
 * (skillfulness required + difficulty, 1–100 sliders) on the claim edge and
 * surfaces to the admin/QA who ultimately marks the job done.
 */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";
import {
  allocatePointsByShares,
  computePeerShareFractions,
  type PointShareInputs,
} from "@/lib/peer-allocation";
import { claimWorkFinished, getLatestWorkClaim } from "@/lib/work-completion";

/** Slider bounds for the claim-complete self-ratings (voucher-style). */
const RATING_MIN = 1;
const RATING_MAX = 100;

export interface JobShareAssignee {
  id: string;
  name: string;
}

export interface JobShareData {
  jobId: string;
  /** Job-level point pool (null = task-points-only job). */
  jobPoints: number | null;
  assignees: JobShareAssignee[];
  /** The viewer's resolved local agent id (null = signed out). */
  viewerId: string | null;
  /** Whether the VIEWER holds an active claim (may rate + claim complete). */
  viewerIsAssignee: boolean;
  /** The viewer's saved weights over the other assignees. */
  myWeights: Record<string, number>;
  /** Aggregate preview: assigneeId → integer points from the current pool. */
  preview: Record<string, number>;
  /** Aggregate share fractions (for bar display even when no pool is set). */
  shareFractions: Record<string, number>;
  /** Whether the viewer already claimed the job finished. */
  viewerClaimedComplete: boolean;
}

/** Loads a live job row. */
async function getJob(jobId: string) {
  const [job] = await db
    .select({ id: resources.id, name: resources.name, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, jobId), eq(resources.type, "job"), isNull(resources.deletedAt)))
    .limit(1);
  return job ?? null;
}

/** Active job-claim holder ids (the assignee set peer allocation runs over). */
async function getActiveAssigneeIds(jobId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT subject_id FROM ledger
    WHERE verb = 'join' AND is_active = true
      AND metadata->>'interactionType' = 'job-claim'
      AND metadata->>'targetId' = ${jobId}
  `)) as Array<{ subject_id: string }>;
  return rows.map((r) => r.subject_id).filter(Boolean).sort();
}

/** Reads the stored per-rater inputs off job metadata. */
function readShareInputs(meta: Record<string, unknown>): PointShareInputs {
  const raw = meta.pointShareInputs;
  return raw && typeof raw === "object" ? (raw as PointShareInputs) : {};
}

/**
 * Resolves everything the job's Points tab needs: the assignee roster with
 * names, the viewer's saved sliders, and the aggregate allocation preview.
 */
export async function getJobShareData(jobId: string): Promise<JobShareData | null> {
  if (!isUuid(jobId)) return null;
  const job = await getJob(jobId);
  if (!job) return null;
  const meta = (job.metadata ?? {}) as Record<string, unknown>;

  const assigneeIds = await getActiveAssigneeIds(jobId);
  const userId = await getCurrentUserId();

  let assignees: JobShareAssignee[] = [];
  if (assigneeIds.length > 0) {
    const rows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(inArray(agents.id, assigneeIds), isNull(agents.deletedAt)));
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    assignees = assigneeIds.map((id) => ({ id, name: nameById.get(id) ?? id.slice(0, 8) }));
  }

  const jobPoints =
    typeof meta.points === "number" && Number.isFinite(meta.points) && meta.points > 0 ? meta.points : null;
  const inputs = readShareInputs(meta);
  const fractions = computePeerShareFractions(assigneeIds, inputs);
  const preview = jobPoints !== null ? allocatePointsByShares(jobPoints, assigneeIds, inputs) : new Map<string, number>();

  const viewerIsAssignee = Boolean(userId && assigneeIds.includes(userId));
  const myRaw = userId ? inputs[userId] : undefined;
  const myWeights: Record<string, number> = {};
  if (myRaw && typeof myRaw === "object") {
    for (const [assigneeId, weight] of Object.entries(myRaw)) {
      const w = Number(weight);
      if (assigneeIds.includes(assigneeId) && Number.isFinite(w) && w > 0) myWeights[assigneeId] = w;
    }
  }

  let viewerClaimedComplete = false;
  if (userId && viewerIsAssignee) {
    const claim = await getLatestWorkClaim(jobId);
    viewerClaimedComplete = Boolean(claim && claim.workerId === userId && claim.isActive && claim.reviewStatus === "claimed");
  }

  return {
    jobId,
    jobPoints,
    assignees,
    viewerId: userId ?? null,
    viewerIsAssignee,
    myWeights,
    preview: Object.fromEntries(preview),
    shareFractions: Object.fromEntries(fractions),
    viewerClaimedComplete,
  };
}

/**
 * Saves the caller's relative point-share sliders over the OTHER assignees.
 * Assignee-gated; self-weights and non-assignee weights are rejected. The
 * final split is computed at job completion from ALL raters' inputs.
 */
export async function setJobPointShareInputAction(
  jobId: string,
  weights: Record<string, number>,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to set point shares." };
  if (!isUuid(jobId)) return { success: false, message: "Invalid job id." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const job = await getJob(jobId);
  if (!job) return { success: false, message: "Job not found." };

  const assigneeIds = await getActiveAssigneeIds(jobId);
  if (!assigneeIds.includes(userId)) {
    return { success: false, message: "Only the job's assignees can set point shares." };
  }

  const cleaned: Record<string, number> = {};
  for (const [assigneeId, weight] of Object.entries(weights ?? {})) {
    if (assigneeId === userId) continue;
    if (!assigneeIds.includes(assigneeId)) continue;
    const w = Number(weight);
    if (!Number.isFinite(w) || w < 0) {
      return { success: false, message: "Point-share weights must be non-negative numbers." };
    }
    if (w > 0) cleaned[assigneeId] = w;
  }

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const inputs = { ...readShareInputs(meta), [userId]: cleaned };

  const facadeResult = await federatedWrite(
    {
      type: "setJobPointShareInputAction",
      actorId: userId,
      targetAgentId: job.ownerId,
      payload: { jobId },
    },
    async () => {
      await db
        .update(resources)
        .set({ metadata: { ...meta, pointShareInputs: inputs }, updatedAt: new Date() })
        .where(eq(resources.id, jobId));
      revalidatePath(`/jobs/${jobId}`);
      return { success: true, message: "Point shares saved." } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to save point shares." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: "job_point_shares_set", jobId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Point shares saved." };
}

/**
 * The worker's job-level "claimed finished" event: records the
 * work-completion claim on the JOB with the voucher-style self-ratings
 * (skillfulness required + difficulty). The job itself stays open — an
 * admin/lead attests by marking it done, which settles pay + points.
 */
export async function claimJobFinishedAction(
  jobId: string,
  ratings: { skillfulness: number; difficulty: number },
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to claim a job complete." };
  if (!isUuid(jobId)) return { success: false, message: "Invalid job id." };

  const skillfulness = Number(ratings?.skillfulness);
  const difficulty = Number(ratings?.difficulty);
  if (
    !Number.isFinite(skillfulness) || skillfulness < RATING_MIN || skillfulness > RATING_MAX ||
    !Number.isFinite(difficulty) || difficulty < RATING_MIN || difficulty > RATING_MAX
  ) {
    return { success: false, message: `Skillfulness and difficulty must be between ${RATING_MIN} and ${RATING_MAX}.` };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const job = await getJob(jobId);
  if (!job) return { success: false, message: "Job not found." };
  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  if (meta.status === "completed") {
    return { success: false, message: "This job is already completed." };
  }

  const assigneeIds = await getActiveAssigneeIds(jobId);
  if (!assigneeIds.includes(userId)) {
    return { success: false, message: "Only an assignee who claimed this job can claim it complete." };
  }

  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;

  const facadeResult = await federatedWrite(
    {
      type: "claimJobFinishedAction",
      actorId: userId,
      targetAgentId: job.ownerId,
      payload: { jobId },
    },
    async () => {
      await claimWorkFinished({
        workerId: userId,
        ref: { targetId: jobId, targetType: "job", ownerId: job.ownerId, jobId, projectId },
        skillfulness,
        difficulty,
      });
      revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);
      return {
        success: true,
        message: "Claimed finished — awaiting review by the job's admin or QA.",
      } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to claim the job complete." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: "job_completion_claimed", jobId, skillfulness, difficulty },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Claimed finished — awaiting review." };
}
