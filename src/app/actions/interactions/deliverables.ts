"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import {
  computeDeliverableProgress,
  deriveDeliverableStatus,
  normalizeDeliverableStatus,
  DEFAULT_DELIVERABLE_STATUS,
  type DeliverableProgress,
  type DeliverableTaskRef,
} from "@/lib/deliverables";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/**
 * Loads a project resource and asserts the caller may administer it (owner or a
 * write-access holder on the owning group). Returns the project row or an error.
 */
async function loadAdministrableProject(
  userId: string,
  projectId: string,
): Promise<
  | { ok: true; ownerId: string; metadata: Record<string, unknown> }
  | { ok: false; result: ActionResult }
> {
  const [project] = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, projectId),
        eq(resources.type, "project"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!project) {
    return {
      ok: false,
      result: { success: false, message: "Project not found." },
    };
  }

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isOwner = project.ownerId === userId;
  const isAdmin = isOwner
    ? true
    : await hasGroupWriteAccess(userId, project.ownerId);

  if (!isAdmin) {
    return {
      ok: false,
      result: {
        success: false,
        message: "You do not have permission to manage this project.",
      },
    };
  }

  return {
    ok: true,
    ownerId: project.ownerId,
    metadata: (project.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Creates a deliverable inside a project. A deliverable is a project-scoped
 * `resource` of type `deliverable` that bundles tasks into a shippable unit.
 *
 * Authorization: the caller must own the project or hold group-write access on
 * the project's owning group.
 *
 * @param input.projectId UUID of the parent project resource.
 * @param input.title Human-readable deliverable name (required).
 * @param input.description Optional longer description.
 * @param input.dueDate Optional ISO due-date string.
 * @returns ActionResult carrying the new deliverable's `resourceId` on success.
 */
export async function createDeliverableAction(input: {
  projectId: string;
  title: string;
  description?: string;
  dueDate?: string | null;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to create a deliverable." };
  }
  if (!isUuid(input.projectId)) {
    return { success: false, message: "Invalid project id." };
  }
  const title = input.title?.trim();
  if (!title) {
    return { success: false, message: "Deliverable title is required." };
  }

  const check = await rateLimit(
    `projects:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  const access = await loadAdministrableProject(userId, input.projectId);
  if (!access.ok) return access.result;

  const groupId =
    typeof access.metadata.groupId === "string" && access.metadata.groupId
      ? access.metadata.groupId
      : access.ownerId;
  const description = input.description?.trim() || null;

  const facadeResult = await federatedWrite(
    {
      type: "createDeliverableAction",
      actorId: userId,
      targetAgentId: access.ownerId,
      payload: input,
    },
    async () => {
      const deliverableId = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(resources)
          .values({
            name: title,
            type: "deliverable",
            description,
            content: description,
            ownerId: access.ownerId,
            visibility: "locale",
            tags: [input.projectId],
            metadata: {
              resourceKind: "deliverable",
              projectId: input.projectId,
              groupId,
              status: DEFAULT_DELIVERABLE_STATUS,
              dueDate: input.dueDate ?? null,
            },
          } as NewResource)
          .returning({ id: resources.id });

        await tx.insert(ledger).values({
          verb: "create",
          subjectId: userId,
          objectId: created.id,
          objectType: "resource",
          resourceId: created.id,
          metadata: {
            resourceType: "deliverable",
            projectId: input.projectId,
            source: "deliverable-action",
          },
        } as NewLedgerEntry);

        return created.id;
      });

      revalidatePath(`/groups/${access.ownerId}`);
      return {
        success: true,
        message: "Deliverable created.",
        resourceId: deliverableId,
      } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to create deliverable." };
  }

  const created = facadeResult.data ?? { success: true, message: "Deliverable created." };
  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: "resource",
    entityId: created.resourceId ?? input.projectId,
    actorId: userId,
    payload: { resourceType: "deliverable", projectId: input.projectId },
  }).catch(() => {});

  return created;
}

/**
 * Assigns (or unassigns) a task to a deliverable by setting the task's
 * `metadata.deliverableId`. Pass `deliverableId: null` to remove the link.
 *
 * Both the task and the deliverable must belong to the same project, and the
 * caller must be able to administer that project.
 *
 * After re-linking, the affected deliverables' status is re-derived from their
 * member-task progress so the deliverable advances/regresses automatically.
 *
 * @param input.taskId UUID of the task resource.
 * @param input.deliverableId UUID of the deliverable, or `null` to unassign.
 * @returns ActionResult.
 */
export async function assignTaskToDeliverableAction(input: {
  taskId: string;
  deliverableId: string | null;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to organize tasks." };
  }
  if (!isUuid(input.taskId)) {
    return { success: false, message: "Invalid task id." };
  }
  if (input.deliverableId !== null && !isUuid(input.deliverableId)) {
    return { success: false, message: "Invalid deliverable id." };
  }

  const check = await rateLimit(
    `projects:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  const [task] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.id, input.taskId),
        eq(resources.type, "task"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!task) return { success: false, message: "Task not found." };

  const taskMeta = (task.metadata ?? {}) as Record<string, unknown>;
  const projectId = typeof taskMeta.projectId === "string" ? taskMeta.projectId : null;
  if (!projectId) {
    return { success: false, message: "Task is not bound to a project." };
  }

  const access = await loadAdministrableProject(userId, projectId);
  if (!access.ok) return access.result;

  // When assigning, verify the deliverable exists and belongs to the SAME
  // project so a task can't be filed under another project's deliverable.
  if (input.deliverableId) {
    const [deliverable] = await db
      .select({ id: resources.id, metadata: resources.metadata })
      .from(resources)
      .where(
        and(
          eq(resources.id, input.deliverableId),
          eq(resources.type, "deliverable"),
          sql`${resources.deletedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (!deliverable) return { success: false, message: "Deliverable not found." };
    const delMeta = (deliverable.metadata ?? {}) as Record<string, unknown>;
    if (delMeta.projectId !== projectId) {
      return {
        success: false,
        message: "Deliverable belongs to a different project.",
      };
    }
  }

  const priorDeliverableId =
    typeof taskMeta.deliverableId === "string" ? taskMeta.deliverableId : null;

  const facadeResult = await federatedWrite(
    {
      type: "assignTaskToDeliverableAction",
      actorId: userId,
      targetAgentId: access.ownerId,
      payload: input,
    },
    async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({
            metadata: { ...taskMeta, deliverableId: input.deliverableId },
            updatedAt: new Date(),
          })
          .where(eq(resources.id, input.taskId));

        await tx.insert(ledger).values({
          verb: "update",
          subjectId: userId,
          objectId: input.taskId,
          objectType: "resource",
          resourceId: input.taskId,
          metadata: {
            interactionType: "task-deliverable-assign",
            taskId: input.taskId,
            deliverableId: input.deliverableId,
            previousDeliverableId: priorDeliverableId,
          },
        } as NewLedgerEntry);
      });

      // Re-derive status for both the new and the previous deliverable.
      const affected = new Set<string>();
      if (input.deliverableId) affected.add(input.deliverableId);
      if (priorDeliverableId) affected.add(priorDeliverableId);
      for (const id of affected) {
        await recomputeDeliverableStatus(id, userId);
      }

      revalidatePath(`/groups/${access.ownerId}`);
      return { success: true, message: "Task organized into deliverable." } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to assign task." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: input.taskId,
    actorId: userId,
    payload: { action: "assign_deliverable", deliverableId: input.deliverableId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Task organized into deliverable." };
}

/**
 * Recomputes a deliverable's progress + status from its member tasks and
 * persists the derived status when it changed. Returns the computed progress.
 *
 * Exported so callers (e.g. task-status transitions) can keep a deliverable's
 * roll-up in sync. Tasks are matched by `metadata.deliverableId`.
 *
 * @param deliverableId UUID of the deliverable resource.
 * @param actorId Agent recording the status change in the ledger.
 * @returns The deliverable's progress roll-up, or `null` if it doesn't exist.
 */
export async function recomputeDeliverableStatus(
  deliverableId: string,
  actorId: string,
): Promise<DeliverableProgress | null> {
  const [deliverable] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.id, deliverableId),
        eq(resources.type, "deliverable"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!deliverable) return null;

  const taskRows = await db.execute(sql`
    SELECT id, metadata->>'status' AS status
    FROM resources
    WHERE type = 'task'
      AND deleted_at IS NULL
      AND metadata->>'deliverableId' = ${deliverableId}
  `);
  const tasks: DeliverableTaskRef[] = (taskRows as Array<Record<string, unknown>>).map(
    (row) => ({ id: String(row.id), status: row.status as string | null }),
  );

  const progress = computeDeliverableProgress(tasks);
  const meta = (deliverable.metadata ?? {}) as Record<string, unknown>;
  const currentStatus = normalizeDeliverableStatus(meta.status);
  const nextStatus = deriveDeliverableStatus(currentStatus, progress);

  if (nextStatus !== currentStatus) {
    await db
      .update(resources)
      .set({
        metadata: { ...meta, status: nextStatus, progressPercent: progress.percent },
        updatedAt: new Date(),
      })
      .where(eq(resources.id, deliverableId));

    await db.insert(ledger).values({
      verb: "update",
      subjectId: actorId,
      objectId: deliverableId,
      objectType: "resource",
      resourceId: deliverableId,
      metadata: {
        interactionType: "deliverable-status-derived",
        previousStatus: currentStatus,
        newStatus: nextStatus,
        progressPercent: progress.percent,
      },
    } as NewLedgerEntry);
  } else if (meta.progressPercent !== progress.percent) {
    // Persist the percent even when status is unchanged so the UI stays fresh.
    await db
      .update(resources)
      .set({ metadata: { ...meta, progressPercent: progress.percent }, updatedAt: new Date() })
      .where(eq(resources.id, deliverableId));
  }

  return progress;
}

/**
 * Lists the deliverables of a project with each one's progress roll-up.
 *
 * Public read (no auth) so project boards render for visitors; visibility of the
 * project itself is enforced upstream by the page that calls this.
 *
 * @param projectId UUID of the project resource.
 * @returns Deliverables with derived progress, ordered by creation time.
 */
export async function listProjectDeliverables(projectId: string): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    progress: DeliverableProgress;
    metadata: Record<string, unknown>;
  }>
> {
  if (!isUuid(projectId)) return [];

  const deliverableRows = await db
    .select({ id: resources.id, name: resources.name, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, "deliverable"),
        sql`${resources.metadata}->>'projectId' = ${projectId}`,
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .orderBy(resources.createdAt);

  if (deliverableRows.length === 0) return [];

  const ids = deliverableRows.map((d) => d.id);
  const taskRows = await db
    .select({ id: resources.id, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, "task"),
        sql`${resources.deletedAt} IS NULL`,
        inArray(sql`${resources.metadata}->>'deliverableId'`, ids),
      ),
    );

  const tasksByDeliverable = new Map<string, DeliverableTaskRef[]>();
  for (const task of taskRows) {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const did = typeof meta.deliverableId === "string" ? meta.deliverableId : null;
    if (!did) continue;
    const list = tasksByDeliverable.get(did) ?? [];
    list.push({ id: task.id, status: meta.status as string | null });
    tasksByDeliverable.set(did, list);
  }

  return deliverableRows.map((d) => {
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return {
      id: d.id,
      name: d.name,
      status: normalizeDeliverableStatus(meta.status),
      progress: computeDeliverableProgress(tasksByDeliverable.get(d.id) ?? []),
      metadata: meta,
    };
  });
}
