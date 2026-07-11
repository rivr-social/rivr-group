"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";

/** Result shape returned by toggleTaskCompletion. */
interface ToggleResult {
  success: boolean;
  message: string;
  completed?: boolean;
  /** Resulting task status — completion may land as `awaiting_approval` when
   *  the toggler is not an authorized verifier (claim → attest rail). */
  status?: "not_started" | "awaiting_approval" | "completed";
}

/** UUID validation pattern. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Toggles a task's completed state through the claim → attest rail
 * (2026-07-10, shared with `updateTaskStatus` via `@/lib/work-completion`):
 *
 * - A verifier (project QA/lead, group/ancestor admin, or the task's owner)
 *   completes in ONE click — the claim is recorded and immediately attested,
 *   awarding `task-points-earned` stake points.
 * - A plain assignee's check-off records the "claimed finished" event and
 *   lands the task in `awaiting_approval`; points move only at attestation.
 * - Un-toggling retracts the claim AND deactivates any awarded points.
 *
 * Authorization: the current user must be the task assignee, the task's
 * owner, or a group admin on the owning agent.
 *
 * @param taskId - UUID of the task resource to toggle.
 * @returns Toggle result with the new completed state + status.
 */
export async function toggleTaskCompletion(taskId: string): Promise<ToggleResult> {
  // Unified session (local, remote-viewer, or MCP execution context) so
  // sovereign-homed admins can complete tasks; lazy import avoids circular
  // deps in the actions barrel.
  const { getCurrentUserId } = await import("@/app/actions/interactions/helpers");
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to complete tasks." };
  }

  if (!UUID_PATTERN.test(taskId)) {
    return { success: false, message: "Invalid task ID." };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

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

  if (!task) {
    return { success: false, message: "Task not found." };
  }

  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo : undefined;
  const isAssignee = assignedTo === userId;
  const isOwner = task.ownerId === userId;

  const jobId = typeof meta.jobId === "string" ? meta.jobId : null;
  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;

  // Check group write access if not direct owner/assignee.
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isGroupAdmin = task.ownerId !== userId
    ? await hasGroupWriteAccess(userId, task.ownerId)
    : false;

  // A worker who claimed the parent job is the task's de-facto assignee — their
  // check-off is a finish-claim awaiting attestation. Without this a job
  // claimant who was never explicitly set as the per-task `assignedTo` (the
  // common case: admin posts a job with tasks, a member claims it) hit "You do
  // not have permission to update this task" and could never do the work
  // (toybox campaign 2026-07-11).
  const { hasActiveJobClaim } = await import("@/app/actions/interactions/project-team");
  const isJobClaimant = jobId ? await hasActiveJobClaim(userId, jobId) : false;

  if (!isAssignee && !isOwner && !isGroupAdmin && !isJobClaimant) {
    return { success: false, message: "You do not have permission to update this task." };
  }

  const {
    resolveProjectAuthority,
    canAttestWork,
    claimWorkFinished,
    attestWork,
    retractWorkClaim,
  } = await import("@/lib/work-completion");

  const targetRef = {
    targetId: taskId,
    targetType: "task" as const,
    ownerId: task.ownerId,
    jobId,
    projectId,
  };

  // A verifier's check-off completes AND attests in one click; a plain
  // assignee's check-off is a finish-claim awaiting attestation.
  let isVerifier = isOwner || isGroupAdmin;
  if (!isVerifier) {
    const authority = await resolveProjectAuthority(targetRef);
    isVerifier = await canAttestWork(userId, task.ownerId, authority);
  }

  const wasDone = meta.completed === true || meta.status === "awaiting_approval";
  const nowCompleted = !wasDone && isVerifier;
  const nextStatus: NonNullable<ToggleResult["status"]> = wasDone
    ? "not_started"
    : isVerifier
      ? "completed"
      : "awaiting_approval";
  const now = new Date().toISOString();

  const statusPatch: Record<string, unknown> = {
    completed: nowCompleted,
    status: nextStatus,
    updatedAt: now,
  };

  if (nextStatus === "completed") {
    statusPatch.completedAt = now;
    statusPatch.completedBy = userId;
  } else if (nextStatus === "awaiting_approval") {
    statusPatch.assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo : userId;
    statusPatch.completedAt = undefined;
    statusPatch.completedBy = undefined;
  } else {
    statusPatch.completedAt = undefined;
    statusPatch.completedBy = undefined;
  }

  const facadeResult = await federatedWrite(
    {
      type: "toggleTaskCompletion",
      actorId: userId,
      targetAgentId: task.ownerId,
      payload: { taskId, completed: nowCompleted },
    },
    async () => {
      // Update the resource metadata.
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
          interactionType: "task-completion-toggle",
          targetId: taskId,
          targetType: "task",
          completed: nowCompleted,
          status: nextStatus,
        },
      } as NewLedgerEntry);

      // Drive the claim → attest rail.
      const pointsValue = typeof meta.points === "number" ? meta.points : 0;
      let message: string;
      if (nextStatus === "completed") {
        const { awardedPoints } = await attestWork({
          verifierId: userId,
          workerId: userId,
          ref: targetRef,
          points: pointsValue,
          outcome: "verified",
        });
        message = awardedPoints > 0 ? `Task completed — ${awardedPoints} points earned!` : "Task completed!";
      } else if (nextStatus === "awaiting_approval") {
        await claimWorkFinished({ workerId: userId, ref: targetRef });
        message = "Marked finished — awaiting attestation.";
      } else {
        const previousWorker =
          typeof meta.completedBy === "string"
            ? meta.completedBy
            : typeof meta.assignedTo === "string"
              ? meta.assignedTo
              : userId;
        await retractWorkClaim(previousWorker, taskId);
        message = "Task marked incomplete.";
      }

      // Revalidate relevant paths.
      revalidatePath("/");
      if (jobId) revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);

      return {
        success: true,
        message,
        completed: nowCompleted,
        status: nextStatus,
      } as ToggleResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to toggle task." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: taskId,
    actorId: userId,
    payload: { taskId, completed: nowCompleted, status: nextStatus },
  }).catch(() => {});

  return (
    facadeResult.data ?? { success: true, message: "Task updated.", completed: nowCompleted, status: nextStatus }
  );
}
