/**
 * Work-completion claim → attestation rail (REA model, 2026-07-10).
 *
 * A worker checking off a task (or claiming a whole job complete) is a CLAIM
 * of finished work — the "claimed finished" economic event — not the
 * completion itself. Attestation by an authorized verifier (project QA,
 * project lead, or a group/ancestor admin) is what verifies the claim and
 * writes the `task-points-earned` stake edge. Stake therefore moves at
 * attestation, never at self-report.
 *
 * This module is the SINGLE writer for both edges, shared by
 * `toggleTaskCompletion` (project page) and `updateTaskStatus` (job page) so
 * the two task-completion surfaces can no longer diverge (the pre-2026-07-10
 * split where only one path awarded points). It also links claims to the
 * worker's RUNNING workperiod server-side, replacing the client-asserted
 * `completedTaskIds` list as the source of truth for what was clicked off
 * during a work session.
 *
 * Ledger shapes:
 * - claim:  verb `complete`, interactionType `work-completion-claim`,
 *   subject = worker, object = task|job, metadata.reviewStatus
 *   'claimed' | 'verified' | 'rejected' (+ proposedPoints, workPeriodId,
 *   skillfulness/difficulty for job-level claims).
 * - points: verb `earn`, interactionType `task-points-earned` (the stake
 *   rail `getMemberStakesForGroup` reads), written ONLY here at attestation,
 *   one ACTIVE edge per worker+target (re-attest reactivates, never
 *   duplicates — fixes the historic toggle-off/on double-award).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { TASK_POINTS_INTERACTION } from "@/lib/queries/stakes";

/** Ledger interactionType for the "claimed finished" REA event. */
export const WORK_COMPLETION_CLAIM_INTERACTION = "work-completion-claim";

/** resourceKind discriminator for workperiod records (mirrors job-timer.ts). */
const WORKPERIOD_KIND = "workperiod";

/** Review lifecycle of a work-completion claim. */
export type WorkClaimReviewStatus = "claimed" | "verified" | "rejected";

export interface WorkTargetRef {
  /** The task or job resource being claimed/attested. */
  targetId: string;
  targetType: "task" | "job";
  /** Owning group agent (resources.owner_id). */
  ownerId: string;
  /** Parent job id when the target is a task (metadata.jobId). */
  jobId: string | null;
  /** Project id threaded for revalidation + stake context. */
  projectId: string | null;
}

/** Lead/QA authority fields resolved from the target's project. */
export interface ProjectAuthority {
  projectId: string | null;
  leadId: string | null;
  /** Effective QA — explicit qaId, defaulting to the lead. */
  qaId: string | null;
}

/**
 * Resolves the project authority (lead + effective QA) for a work target by
 * walking task → job → project metadata. Missing links resolve to nulls so
 * attestation gracefully falls back to group-admin authority alone.
 */
export async function resolveProjectAuthority(
  ref: Pick<WorkTargetRef, "targetType" | "jobId" | "projectId">,
): Promise<ProjectAuthority> {
  let projectId = ref.projectId;

  if (!projectId && ref.jobId) {
    const [job] = await db
      .select({ metadata: resources.metadata })
      .from(resources)
      .where(and(eq(resources.id, ref.jobId), eq(resources.type, "job"), isNull(resources.deletedAt)))
      .limit(1);
    const jobMeta = (job?.metadata ?? {}) as Record<string, unknown>;
    projectId = typeof jobMeta.projectId === "string" ? jobMeta.projectId : null;
  }

  if (!projectId) return { projectId: null, leadId: null, qaId: null };

  // Projects are dual-shape: a `resources` row (type 'project') OR a
  // project-typed `agents` row. Check both homes for the role metadata.
  const [projectResource] = await db
    .select({ metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, projectId), eq(resources.type, "project"), isNull(resources.deletedAt)))
    .limit(1);
  let meta = projectResource?.metadata as Record<string, unknown> | undefined;
  if (!meta) {
    const [projectAgent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, projectId), isNull(agents.deletedAt)))
      .limit(1);
    meta = projectAgent?.metadata as Record<string, unknown> | undefined;
  }

  const leadId = typeof meta?.leadId === "string" ? meta.leadId : null;
  const qaId = typeof meta?.qaId === "string" ? meta.qaId : leadId;
  return { projectId, leadId, qaId };
}

/**
 * Whether `userId` may ATTEST (verify/reject) work on the target: the
 * project's effective QA, the project lead, or a group admin — of the owning
 * group OR any ancestor (`isGroupAdmin` cascades via pathIds). When the QA is
 * a GROUP agent (an affiliated group acting as QA), that group's admins hold
 * the authority.
 */
export async function canAttestWork(
  userId: string,
  ownerId: string,
  authority: ProjectAuthority,
): Promise<boolean> {
  if (authority.leadId === userId || authority.qaId === userId) return true;

  const { isGroupAdmin } = await import("@/app/actions/group-admin");
  if (await isGroupAdmin(userId, ownerId)) return true;

  // Group-agent QA: the QA id names a group; its admins attest on its behalf.
  if (authority.qaId && authority.qaId !== userId) {
    const [qaAgent] = await db
      .select({ id: agents.id, type: agents.type })
      .from(agents)
      .where(and(eq(agents.id, authority.qaId), isNull(agents.deletedAt)))
      .limit(1);
    if (qaAgent && qaAgent.type !== "person" && (await isGroupAdmin(userId, authority.qaId))) {
      return true;
    }
  }

  return false;
}

/**
 * The most recent work-completion claim on a target regardless of worker —
 * how attestation surfaces resolve WHO to credit when the task row itself
 * carries no assignee.
 */
export async function getLatestWorkClaim(targetId: string): Promise<{
  workerId: string;
  proposedPoints: number | null;
  reviewStatus: string;
  isActive: boolean;
} | null> {
  const rows = (await db.execute(sql`
    SELECT subject_id, is_active, metadata
    FROM ledger
    WHERE verb = 'complete'
      AND object_id = ${targetId}::uuid
      AND metadata->>'interactionType' = ${WORK_COMPLETION_CLAIM_INTERACTION}
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<{ subject_id: string; is_active: boolean; metadata: Record<string, unknown> }>;
  const row = rows[0];
  if (!row) return null;
  const meta = row.metadata ?? {};
  const proposed = Number(meta.proposedPoints);
  return {
    workerId: row.subject_id,
    proposedPoints: Number.isFinite(proposed) && proposed > 0 ? proposed : null,
    reviewStatus: String(meta.reviewStatus ?? "claimed"),
    isActive: row.is_active === true,
  };
}

/** The worker's most recent claim edge on a target, if any. */
async function findClaimEdge(workerId: string, targetId: string) {
  const rows = (await db.execute(sql`
    SELECT id, is_active, metadata
    FROM ledger
    WHERE subject_id = ${workerId}::uuid
      AND verb = 'complete'
      AND object_id = ${targetId}::uuid
      AND metadata->>'interactionType' = ${WORK_COMPLETION_CLAIM_INTERACTION}
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<{ id: string; is_active: boolean; metadata: Record<string, unknown> }>;
  return rows[0] ?? null;
}

/** The worker's RUNNING workperiod on a job, if any. */
async function findRunningWorkPeriod(workerId: string, jobId: string) {
  const rows = await db
    .select({ id: resources.id, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, "resource"),
        eq(resources.ownerId, workerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->>'resourceKind' = ${WORKPERIOD_KIND}`,
        sql`${resources.metadata}->>'jobId' = ${jobId}`,
        sql`${resources.metadata}->>'stoppedAt' IS NULL`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ClaimWorkInput {
  workerId: string;
  ref: WorkTargetRef;
  /** Worker-proposed point value (job claimants may propose task points). */
  proposedPoints?: number | null;
  /** Job-level completion-claim self-ratings (1–10 sliders). */
  skillfulness?: number | null;
  difficulty?: number | null;
}

/**
 * Records the worker's "claimed finished" event: writes (or reactivates) the
 * work-completion-claim edge and links the worker's running workperiod on the
 * job — appending the target to the workperiod's `tasksCompletedDuringPeriod`
 * server-side. Idempotent per worker+target: an existing active 'claimed'
 * edge is left as-is.
 *
 * @returns The claim edge's workPeriodId linkage (null when no timer ran).
 */
export async function claimWorkFinished(input: ClaimWorkInput): Promise<{ workPeriodId: string | null }> {
  const { workerId, ref } = input;
  const now = new Date().toISOString();

  // Link the running workperiod (task claims link via the parent job).
  const timerJobId = ref.targetType === "job" ? ref.targetId : ref.jobId;
  let workPeriodId: string | null = null;
  if (timerJobId) {
    const period = await findRunningWorkPeriod(workerId, timerJobId);
    if (period) {
      workPeriodId = period.id;
      const meta = (period.metadata ?? {}) as Record<string, unknown>;
      const linked = Array.isArray(meta.tasksCompletedDuringPeriod)
        ? meta.tasksCompletedDuringPeriod.filter((t): t is string => typeof t === "string")
        : [];
      if (!linked.includes(ref.targetId)) {
        await db
          .update(resources)
          .set({
            metadata: { ...meta, tasksCompletedDuringPeriod: [...linked, ref.targetId] },
            updatedAt: new Date(),
          })
          .where(eq(resources.id, period.id));
      }
    }
  }

  const existing = await findClaimEdge(workerId, ref.targetId);
  const claimMeta: Record<string, unknown> = {
    interactionType: WORK_COMPLETION_CLAIM_INTERACTION,
    targetId: ref.targetId,
    targetType: ref.targetType,
    jobId: ref.jobId ?? (ref.targetType === "job" ? ref.targetId : null),
    projectId: ref.projectId,
    workPeriodId,
    reviewStatus: "claimed" satisfies WorkClaimReviewStatus,
    claimedAt: now,
    ...(typeof input.proposedPoints === "number" && input.proposedPoints >= 0
      ? { proposedPoints: input.proposedPoints }
      : {}),
    ...(typeof input.skillfulness === "number" ? { skillfulness: input.skillfulness } : {}),
    ...(typeof input.difficulty === "number" ? { difficulty: input.difficulty } : {}),
  };

  if (existing) {
    const status = String((existing.metadata ?? {}).reviewStatus ?? "");
    if (existing.is_active && status === "claimed") {
      return { workPeriodId }; // already claimed, awaiting attestation
    }
    // Re-claim after rejection/retraction: reactivate with fresh claim state.
    await db.execute(sql`
      UPDATE ledger
      SET is_active = true,
          metadata = metadata || ${JSON.stringify(claimMeta)}::jsonb
      WHERE id = ${existing.id}::uuid
    `);
    return { workPeriodId };
  }

  await db.insert(ledger).values({
    subjectId: workerId,
    verb: "complete",
    objectId: ref.targetId,
    objectType: "resource",
    resourceId: ref.targetId,
    isActive: true,
    metadata: claimMeta,
  } as NewLedgerEntry);

  return { workPeriodId };
}

export interface AttestWorkInput {
  verifierId: string;
  /** The worker whose claim is being attested. */
  workerId: string;
  ref: WorkTargetRef;
  /** Point value awarded — attested override, else claim proposal, else the
   *  target's own metadata.points. Non-positive/absent awards nothing. */
  points: number | null;
  outcome: Extract<WorkClaimReviewStatus, "verified" | "rejected">;
}

/**
 * Attests a work-completion claim: flips the claim edge to verified/rejected
 * and, on verification, writes the `task-points-earned` stake edge (one
 * active edge per worker+target — re-attestation updates in place).
 * Creates the claim edge implicitly when a verifier completes work that was
 * never self-claimed (one-click lead/admin flow).
 */
export async function attestWork(input: AttestWorkInput): Promise<{ awardedPoints: number }> {
  const { verifierId, workerId, ref, outcome } = input;
  const now = new Date().toISOString();

  let claim = await findClaimEdge(workerId, ref.targetId);
  if (!claim) {
    await claimWorkFinished({ workerId, ref });
    claim = await findClaimEdge(workerId, ref.targetId);
  }

  const attestPatch: Record<string, unknown> = {
    reviewStatus: outcome,
    verifiedBy: verifierId,
    verifiedAt: now,
  };

  const points =
    typeof input.points === "number" && Number.isFinite(input.points) && input.points > 0
      ? input.points
      : 0;

  if (outcome === "verified" && points > 0) attestPatch.awardedPoints = points;

  if (claim) {
    await db.execute(sql`
      UPDATE ledger
      SET is_active = ${outcome === "verified"},
          metadata = metadata || ${JSON.stringify(attestPatch)}::jsonb
      WHERE id = ${claim.id}::uuid
    `);
  }

  if (outcome === "rejected") {
    await deactivatePointsEdge(workerId, ref.targetId);
    return { awardedPoints: 0 };
  }

  if (points <= 0) return { awardedPoints: 0 };

  // One ACTIVE points edge per worker+target: update in place on re-attest.
  const existingPoints = (await db.execute(sql`
    SELECT id FROM ledger
    WHERE subject_id = ${workerId}::uuid
      AND verb = 'earn'
      AND object_id = ${ref.targetId}::uuid
      AND metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<{ id: string }>;

  const pointsMeta = {
    interactionType: TASK_POINTS_INTERACTION,
    targetId: ref.targetId,
    targetType: ref.targetType,
    points,
    attestedBy: verifierId,
    attestedAt: now,
  };

  if (existingPoints.length > 0) {
    await db.execute(sql`
      UPDATE ledger
      SET is_active = true,
          metadata = metadata || ${JSON.stringify(pointsMeta)}::jsonb
      WHERE id = ${existingPoints[0].id}::uuid
    `);
  } else {
    await db.insert(ledger).values({
      subjectId: workerId,
      verb: "earn",
      objectId: ref.targetId,
      objectType: "resource",
      metadata: pointsMeta,
    } as NewLedgerEntry);
  }

  return { awardedPoints: points };
}

/**
 * Retracts a worker's claim (task reopened / toggled back off): deactivates
 * the claim edge AND any active points edge so stake never counts un-done
 * work. Safe when nothing exists.
 */
export async function retractWorkClaim(workerId: string, targetId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ledger
    SET is_active = false,
        metadata = metadata || ${JSON.stringify({ reviewStatus: "claimed", retractedAt: new Date().toISOString() })}::jsonb
    WHERE subject_id = ${workerId}::uuid
      AND verb = 'complete'
      AND object_id = ${targetId}::uuid
      AND metadata->>'interactionType' = ${WORK_COMPLETION_CLAIM_INTERACTION}
      AND is_active = true
  `);
  await deactivatePointsEdge(workerId, targetId);
}

/** Deactivates the worker's active points edge on a target (reject/retract). */
async function deactivatePointsEdge(workerId: string, targetId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ledger
    SET is_active = false
    WHERE subject_id = ${workerId}::uuid
      AND verb = 'earn'
      AND object_id = ${targetId}::uuid
      AND metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
      AND is_active = true
  `);
}
