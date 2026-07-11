"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import {
  getCurrentUserId,
  toggleLedgerInteraction,
} from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/**
 * Claims a batch of tasks by assigning them to the current user in the ledger.
 *
 * Each task ID is recorded as an individual ledger entry with verb `join` and
 * interactionType `task-claim`. Duplicate claims are silently skipped via the
 * toggle behavior in `toggleLedgerInteraction`.
 *
 * @param {string[]} taskIds - Array of task resource UUIDs to claim.
 * @returns {Promise<ActionResult>} Result reflecting final state after all claims.
 * @throws {Error} Unexpected DB failures from lower-level helpers may propagate.
 * @example
 * ```ts
 * await claimTasksAction(["task-uuid-1", "task-uuid-2"]);
 * ```
 */
export async function claimTasksAction(taskIds: string[]): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to claim tasks." };

  const validIds = taskIds.filter(isUuid);
  if (validIds.length === 0) {
    return { success: false, message: "No valid task IDs provided." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const facadeResult = await federatedWrite(
    {
      type: 'claimTasksAction',
      actorId: userId,
      targetAgentId: userId,
      payload: { taskIds: validIds },
    },
    async () => {
      for (const taskId of validIds) {
        await toggleLedgerInteraction(userId, "join", "task-claim", taskId, "resource");
      }

      revalidatePath("/");
      return {
        success: true,
        message: `${validIds.length} task${validIds.length === 1 ? "" : "s"} claimed successfully.`,
      } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to claim tasks." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: validIds[0],
    actorId: userId,
    payload: { action: 'claim_tasks', taskIds: validIds },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Tasks claimed successfully." };
}

/** Valid task status transitions. */
type TaskStatus = "not_started" | "in_progress" | "awaiting_approval" | "completed" | "rejected";

const VALID_TASK_STATUSES: readonly TaskStatus[] = [
  "not_started",
  "in_progress",
  "awaiting_approval",
  "completed",
  "rejected",
] as const;

/** Attestation-time options for updateTaskStatus. */
export interface TaskStatusOptions {
  /** Worker's proposed point value on a finish-claim (`awaiting_approval`). */
  proposedPoints?: number | null;
  /** Verifier's point override at attestation (`completed`). */
  attestedPoints?: number | null;
}

/**
 * Updates a task resource's status in the database, driving the
 * claim → attest work-completion rail (2026-07-10):
 *
 * - `awaiting_approval` records the worker's "claimed finished" REA event
 *   (`work-completion-claim` edge) and links their running workperiod.
 * - `completed` / `rejected` are ATTESTATIONS — allowed for the project QA,
 *   project lead, or a group/ancestor admin (`canAttestWork`). Verification
 *   writes the `task-points-earned` stake edge (attested override → claim
 *   proposal → the task's own points, in that order).
 * - `not_started` retracts any claim + points so stake never counts un-done
 *   work.
 *
 * Base authorization: assignee, direct owner, or group admin.
 *
 * @param {string} taskId - UUID of the task resource.
 * @param {TaskStatus} newStatus - Target status value.
 * @param {TaskStatusOptions} [opts] - Point proposal/override values.
 * @returns {Promise<ActionResult>} Success/failure result.
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: TaskStatus,
  opts?: TaskStatusOptions,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to update tasks." };
  if (!isUuid(taskId)) return { success: false, message: "Invalid task ID." };
  if (!VALID_TASK_STATUSES.includes(newStatus)) {
    return { success: false, message: `Invalid status: ${newStatus}` };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  // Fetch the task resource.
  const [task] = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, taskId),
        eq(resources.type, "task"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!task) return { success: false, message: "Task not found." };

  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo : undefined;
  const jobId = typeof meta.jobId === "string" ? meta.jobId : null;
  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;

  // Authorization: assignee, direct owner, or group admin.
  const isAssignee = assignedTo === userId;
  const isOwner = task.ownerId === userId;

  // Import hasGroupWriteAccess lazily to avoid circular dependency.
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isGroupAdmin = task.ownerId !== userId
    ? await hasGroupWriteAccess(userId, task.ownerId)
    : false;

  // A worker who claimed the parent job is the task's de-facto assignee, so a
  // non-attestation status change (starting/finishing their own work) is
  // allowed even without an explicit per-task `assignedTo` (toybox campaign
  // 2026-07-11). Attestation stays gated to the verifier set below.
  const { hasActiveJobClaim } = await import("@/app/actions/interactions/project-team");
  const isJobClaimant = jobId ? await hasActiveJobClaim(userId, jobId) : false;

  const {
    resolveProjectAuthority,
    canAttestWork,
    claimWorkFinished,
    attestWork,
    retractWorkClaim,
    getLatestWorkClaim,
  } = await import("@/lib/work-completion");

  const targetRef = {
    targetId: taskId,
    targetType: "task" as const,
    ownerId: task.ownerId,
    jobId,
    projectId,
  };

  // Attestations widen beyond group authority to the project lead/QA.
  const isAttestation = newStatus === "completed" || newStatus === "rejected";
  let isVerifier = isOwner || isGroupAdmin;
  if (isAttestation && !isVerifier) {
    const authority = await resolveProjectAuthority(targetRef);
    isVerifier = await canAttestWork(userId, task.ownerId, authority);
  }

  if (!isAssignee && !isOwner && !isGroupAdmin && !isJobClaimant && !(isAttestation && isVerifier)) {
    return { success: false, message: "You do not have permission to update this task." };
  }

  if (isAttestation && !isVerifier) {
    return {
      success: false,
      message: "Only the project QA, project lead, or a group admin can attest task completion.",
    };
  }

  // Whose work is being attested: the assignee, else the latest claimant,
  // else the verifier themself (one-click lead completing their own task).
  let workerId = userId;
  if (isAttestation) {
    if (assignedTo) {
      workerId = assignedTo;
    } else {
      const latestClaim = await getLatestWorkClaim(taskId);
      if (latestClaim) workerId = latestClaim.workerId;
    }
  }

  const now = new Date().toISOString();
  const statusPatch: Record<string, unknown> = { status: newStatus, updatedAt: now };

  if (newStatus === "completed") {
    statusPatch.completedAt = now;
    statusPatch.completedBy = workerId;
    statusPatch.completed = true;
  } else if (newStatus === "rejected") {
    statusPatch.completed = false;
    statusPatch.completedAt = undefined;
    statusPatch.completedBy = undefined;
  } else if (newStatus === "awaiting_approval") {
    statusPatch.assignedTo = assignedTo ?? userId;
  } else if (newStatus === "not_started") {
    statusPatch.completed = false;
    statusPatch.assignedTo = undefined;
    statusPatch.completedAt = undefined;
    statusPatch.completedBy = undefined;
  } else if (newStatus === "in_progress") {
    statusPatch.assignedTo = assignedTo ?? userId;
    statusPatch.completed = false;
  }

  const facadeResult = await federatedWrite(
    {
      type: 'updateTaskStatus',
      actorId: userId,
      targetAgentId: task.ownerId,
      payload: { taskId, newStatus },
    },
    async () => {
      await db
        .update(resources)
        .set({
          metadata: { ...meta, ...statusPatch },
          updatedAt: new Date(),
        })
        .where(eq(resources.id, taskId));

      // Record status change in ledger.
      await db.insert(ledger).values({
        subjectId: userId,
        verb: "update",
        objectId: taskId,
        objectType: "resource",
        metadata: {
          interactionType: "task-status-update",
          targetId: taskId,
          targetType: "task",
          previousStatus: typeof meta.status === "string" ? meta.status : "not_started",
          newStatus,
        },
      } as NewLedgerEntry);

      // Drive the claim → attest rail off the status transition.
      let attestNote = "";
      if (newStatus === "awaiting_approval") {
        // The finish-claim always belongs to the acting worker.
        await claimWorkFinished({
          workerId: userId,
          ref: targetRef,
          proposedPoints: opts?.proposedPoints ?? null,
        });
        attestNote = " — awaiting attestation";
      } else if (newStatus === "completed" || newStatus === "rejected") {
        const latestClaim = await getLatestWorkClaim(taskId);
        const taskPoints = typeof meta.points === "number" ? meta.points : 0;
        const points =
          typeof opts?.attestedPoints === "number" && opts.attestedPoints >= 0
            ? opts.attestedPoints
            : latestClaim?.proposedPoints ?? taskPoints;
        const { awardedPoints } = await attestWork({
          verifierId: userId,
          workerId,
          ref: targetRef,
          points,
          outcome: newStatus === "completed" ? "verified" : "rejected",
        });
        if (newStatus === "completed" && awardedPoints > 0) {
          attestNote = ` — ${awardedPoints} points attested`;
        }
      } else if (newStatus === "not_started") {
        // Reopen: retract the previous claimant's claim + points.
        const previousWorker =
          typeof meta.completedBy === "string" ? meta.completedBy : assignedTo ?? userId;
        await retractWorkClaim(previousWorker, taskId);
      }

      // Keep the parent deliverable's progress/status roll-up in sync (J3).
      const deliverableId = typeof meta.deliverableId === "string" ? meta.deliverableId : undefined;
      if (deliverableId) {
        const { recomputeDeliverableStatus } = await import("./deliverables");
        await recomputeDeliverableStatus(deliverableId, userId);
      }

      // Revalidate task-visible paths.
      revalidatePath("/");
      if (jobId) revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);
      revalidatePath(`/groups/${task.ownerId}`);

      return { success: true, message: `Task status updated to ${newStatus}${attestNote}.` } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to update task status." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: taskId,
    actorId: userId,
    payload: { taskId, newStatus },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: `Task status updated to ${newStatus}.` };
}
