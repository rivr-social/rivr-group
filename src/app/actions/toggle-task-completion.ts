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
}

/** UUID validation pattern. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Toggles a task's completed status and awards points via a ledger entry
 * when completing.
 *
 * Authorization: the current user must be the task assignee, the task's
 * owner, or a group admin on the owning agent.
 *
 * @param taskId - UUID of the task resource to toggle.
 * @returns Toggle result with the new completed state.
 */
export async function toggleTaskCompletion(taskId: string): Promise<ToggleResult> {
  // Lazy auth import to avoid circular deps in the actions barrel.
  const { auth } = await import("@/auth");
  const session = await auth();
  const userId = session?.user?.id;
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

  // Check group write access if not direct owner/assignee.
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isGroupAdmin = task.ownerId !== userId
    ? await hasGroupWriteAccess(userId, task.ownerId)
    : false;

  if (!isAssignee && !isOwner && !isGroupAdmin) {
    return { success: false, message: "You do not have permission to update this task." };
  }

  const wasCompleted = meta.completed === true;
  const nowCompleted = !wasCompleted;
  const now = new Date().toISOString();

  const statusPatch: Record<string, unknown> = {
    completed: nowCompleted,
    status: nowCompleted ? "completed" : "not_started",
    updatedAt: now,
  };

  if (nowCompleted) {
    statusPatch.completedAt = now;
    statusPatch.completedBy = userId;
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
        },
      } as NewLedgerEntry);

      // Award points when completing a task.
      const pointsValue = typeof meta.points === "number" ? meta.points : 0;
      if (nowCompleted && pointsValue > 0) {
        await db.insert(ledger).values({
          subjectId: userId,
          verb: "earn",
          objectId: taskId,
          objectType: "resource",
          metadata: {
            interactionType: "task-points-earned",
            targetId: taskId,
            targetType: "task",
            points: pointsValue,
          },
        } as NewLedgerEntry);
      }

      // Revalidate relevant paths.
      const jobId = typeof meta.jobId === "string" ? meta.jobId : undefined;
      const projectId = typeof meta.projectId === "string" ? meta.projectId : undefined;
      revalidatePath("/");
      if (jobId) revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);

      return {
        success: true,
        message: nowCompleted ? "Task completed!" : "Task marked incomplete.",
        completed: nowCompleted,
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
    payload: { taskId, completed: nowCompleted },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Task updated.", completed: nowCompleted };
}
