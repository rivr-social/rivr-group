"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
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

  const facadeResult = await updateFacade.execute(
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

/**
 * Updates a task resource's status in the database.
 *
 * Authorization: the current user must be the task assignee, the task's
 * owner, or hold write access to the owning group. Admin-only statuses
 * (`completed`, `rejected`) additionally require group-write permission
 * when the resource is group-owned.
 *
 * @param {string} taskId - UUID of the task resource.
 * @param {TaskStatus} newStatus - Target status value.
 * @returns {Promise<ActionResult>} Success/failure result.
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: TaskStatus,
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

  // Authorization: assignee, direct owner, or group admin.
  const isAssignee = assignedTo === userId;
  const isOwner = task.ownerId === userId;

  // Import hasGroupWriteAccess lazily to avoid circular dependency.
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isGroupAdmin = task.ownerId !== userId
    ? await hasGroupWriteAccess(userId, task.ownerId)
    : false;

  if (!isAssignee && !isOwner && !isGroupAdmin) {
    return { success: false, message: "You do not have permission to update this task." };
  }

  // Admin-only transitions: only group admin/owner can approve or reject.
  if ((newStatus === "completed" || newStatus === "rejected") && !isOwner && !isGroupAdmin) {
    return { success: false, message: "Only the job owner or a group admin can approve or reject tasks." };
  }

  const now = new Date().toISOString();
  const statusPatch: Record<string, unknown> = { status: newStatus, updatedAt: now };

  if (newStatus === "completed") {
    statusPatch.completedAt = now;
    statusPatch.completedBy = userId;
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

  const facadeResult = await updateFacade.execute(
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

      // Revalidate task-visible paths.
      const jobId = typeof meta.jobId === "string" ? meta.jobId : undefined;
      revalidatePath("/");
      if (jobId) revalidatePath(`/jobs/${jobId}`);
      revalidatePath(`/groups/${task.ownerId}`);

      return { success: true, message: `Task status updated to ${newStatus}.` } as ActionResult;
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
