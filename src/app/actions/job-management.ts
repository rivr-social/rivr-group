"use server";

/**
 * Post-creation project/job structure editing (2026-07-07 projects sprint).
 *
 * Projects, jobs, and tasks are created atomically on the create page, but
 * admins need to keep evolving the structure afterwards: add a job to a
 * running project, add tasks to a job that shipped without them (the
 * coeurulea content pass), and adjust compensation. These actions mirror the
 * nested inserts in `resource-creation/lifecycle.ts` exactly — same resource
 * types, metadata shapes, and ledger provenance rows — and inherit
 * visibility/tags/scope from the parent resource so added children surface
 * wherever the parent does.
 *
 * Field-level edits (name, description, pay, schedule) go through the shared
 * authority-checked `updateResource` action; these cover structural adds.
 */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";

// ─── Input types ────────────────────────────────────────────────────────────

export interface AddJobToProjectInput {
  title: string;
  description?: string;
  category?: string | null;
  location?: string | null;
  priority?: "low" | "medium" | "high" | null;
  maxAssignees?: number | null;
  requiredBadges?: string[];
  startDate?: string | null;
  deadline?: string | null;
  /** Cash compensation alongside task points; null/omitted = points-only. */
  payKind?: "fixed" | "hourly" | null;
  payAmountCents?: number | null;
  hourlyRateCents?: number | null;
  /** Claim gating (mirrors create-page options). */
  claimApprovalRequired?: boolean;
  claimGateMembership?: boolean;
  claimGateAdmin?: boolean;
}

export interface AddTaskToJobInput {
  name: string;
  description?: string;
  points?: number | null;
  estimatedTime?: string | null;
  required?: boolean;
  assignedTo?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParentResource {
  id: string;
  name: string;
  ownerId: string;
  visibility: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** Resource types a child can be added under. */
type ParentResourceType = "project" | "job" | "shift";

/** Loads a live parent resource of the expected type(s). */
async function getParentResource(
  resourceId: string,
  types: ParentResourceType[],
): Promise<ParentResource | null> {
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      ownerId: resources.ownerId,
      visibility: resources.visibility,
      tags: resources.tags,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        inArray(resources.type, types),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    visibility: row.visibility ?? "public",
    tags: Array.isArray(row.tags) ? row.tags : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/** Owner-or-group-write authorization on the parent's owning agent. */
async function canManageParent(userId: string, parent: ParentResource): Promise<boolean> {
  if (parent.ownerId === userId) return true;
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  return hasGroupWriteAccess(userId, parent.ownerId);
}

/** Normalizes the pay-field triple, dropping values inconsistent with payKind. */
function normalizePayFields(input: {
  payKind?: "fixed" | "hourly" | null;
  payAmountCents?: number | null;
  hourlyRateCents?: number | null;
}): { payKind: "fixed" | "hourly" | null; payAmountCents: number | null; hourlyRateCents: number | null } {
  const payKind = input.payKind === "fixed" || input.payKind === "hourly" ? input.payKind : null;
  const payAmountCents =
    payKind === "fixed" && Number.isInteger(input.payAmountCents) && (input.payAmountCents as number) > 0
      ? (input.payAmountCents as number)
      : null;
  const hourlyRateCents =
    payKind === "hourly" && Number.isInteger(input.hourlyRateCents) && (input.hourlyRateCents as number) > 0
      ? (input.hourlyRateCents as number)
      : null;
  return { payKind, payAmountCents, hourlyRateCents };
}

// ─── Server Actions ─────────────────────────────────────────────────────────

/**
 * Adds a job to an existing project. Mirrors the nested-job insert of
 * `createProjectResource` (resource type `job`, `metadata.projectId` link,
 * ledger `create` provenance) and inherits the project's visibility, tags,
 * and scope fields so the job surfaces wherever the project does.
 *
 * Authorization: project owner or group write access on the owning agent.
 */
export async function addJobToProjectAction(
  projectId: string,
  input: AddJobToProjectInput,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to add a job." };
  if (!isUuid(projectId)) return { success: false, message: "Invalid project id." };

  const title = input.title?.trim();
  if (!title) return { success: false, message: "A job title is required." };

  const check = await rateLimit(
    `resources:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const project = await getParentResource(projectId, ["project"]);
  if (!project) return { success: false, message: "Project not found." };
  if (!(await canManageParent(userId, project))) {
    return { success: false, message: "Only the project owner or a group admin can add jobs." };
  }

  const description = input.description?.trim() || "";
  const pay = normalizePayFields(input);
  const projectMeta = project.metadata;

  const facadeResult = await federatedWrite(
    {
      type: "addJobToProjectAction",
      actorId: userId,
      targetAgentId: project.ownerId,
      payload: { projectId, title },
    },
    async () => {
      const [createdJob] = await db
        .insert(resources)
        .values({
          name: title,
          type: "job",
          description: description || null,
          content: description || null,
          ownerId: project.ownerId,
          visibility: project.visibility,
          tags: project.tags,
          metadata: {
            resourceKind: "job",
            projectId: project.id,
            groupId: projectMeta.groupId ?? project.ownerId,
            chapterTags: projectMeta.chapterTags ?? [],
            scopedLocaleIds: projectMeta.scopedLocaleIds ?? [],
            scopedGroupIds: projectMeta.scopedGroupIds ?? [],
            scopedUserIds: projectMeta.scopedUserIds ?? [],
            isGlobal: projectMeta.isGlobal === true,
            category: input.category ?? null,
            priority: input.priority ?? null,
            location: input.location ?? null,
            maxAssignees:
              Number.isInteger(input.maxAssignees) && (input.maxAssignees as number) > 0
                ? input.maxAssignees
                : null,
            requiredBadges: Array.isArray(input.requiredBadges) ? input.requiredBadges : [],
            skills: [],
            claimApprovalRequired: input.claimApprovalRequired === true,
            claimGateMembership: input.claimGateMembership === true,
            claimGateAdmin: input.claimGateAdmin === true,
            startDate: typeof input.startDate === "string" ? input.startDate : null,
            deadline: typeof input.deadline === "string" ? input.deadline : null,
            date: null,
            status: "open",
            payKind: pay.payKind,
            payAmountCents: pay.payAmountCents,
            hourlyRateCents: pay.hourlyRateCents,
            createdBy: userId,
          },
        } as NewResource)
        .returning({ id: resources.id });

      await db.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: createdJob.id,
        objectType: "resource",
        resourceId: createdJob.id,
        metadata: {
          resourceType: "job",
          projectId: project.id,
          source: "job-management",
        },
      } as NewLedgerEntry);

      revalidatePath(`/projects/${project.id}`);
      revalidatePath(`/groups/${project.ownerId}`);

      return { success: true, message: "Job added.", resourceId: createdJob.id } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to add the job." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: projectId,
    actorId: userId,
    payload: { action: "job_added", projectId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Job added." };
}

/**
 * Adds a task to an existing job. Mirrors the nested-task insert of
 * `createProjectResource` (resource type `task`, `metadata.jobId`/`projectId`
 * links, points, ledger `create` provenance) and inherits the job's
 * visibility, tags, and scope fields.
 *
 * Authorization: job owner or group write access on the owning agent.
 */
export async function addTaskToJobAction(
  jobId: string,
  input: AddTaskToJobInput,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to add a task." };
  if (!isUuid(jobId)) return { success: false, message: "Invalid job id." };

  const name = input.name?.trim();
  if (!name) return { success: false, message: "A task name is required." };

  const points =
    typeof input.points === "number" && Number.isFinite(input.points) && input.points >= 0
      ? input.points
      : null;

  const check = await rateLimit(
    `resources:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const job = await getParentResource(jobId, ["job", "shift"]);
  if (!job) return { success: false, message: "Job not found." };
  if (!(await canManageParent(userId, job))) {
    return { success: false, message: "Only the job owner or a group admin can add tasks." };
  }

  const description = input.description?.trim() || "";
  const jobMeta = job.metadata;
  const projectId = typeof jobMeta.projectId === "string" ? jobMeta.projectId : null;

  const facadeResult = await federatedWrite(
    {
      type: "addTaskToJobAction",
      actorId: userId,
      targetAgentId: job.ownerId,
      payload: { jobId, name },
    },
    async () => {
      const [createdTask] = await db
        .insert(resources)
        .values({
          name,
          type: "task",
          description: description || null,
          content: description || null,
          ownerId: job.ownerId,
          visibility: job.visibility,
          tags: job.tags,
          metadata: {
            resourceKind: "task",
            projectId,
            jobId: job.id,
            groupId: jobMeta.groupId ?? job.ownerId,
            chapterTags: jobMeta.chapterTags ?? [],
            scopedLocaleIds: jobMeta.scopedLocaleIds ?? [],
            scopedGroupIds: jobMeta.scopedGroupIds ?? [],
            scopedUserIds: jobMeta.scopedUserIds ?? [],
            isGlobal: jobMeta.isGlobal === true,
            estimatedTime: typeof input.estimatedTime === "string" ? input.estimatedTime : null,
            points,
            required: input.required !== false,
            ...(typeof input.assignedTo === "string" && isUuid(input.assignedTo)
              ? { assignedTo: input.assignedTo }
              : {}),
            status: "not_started",
            completed: false,
            createdBy: userId,
          },
        } as NewResource)
        .returning({ id: resources.id });

      await db.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: createdTask.id,
        objectType: "resource",
        resourceId: createdTask.id,
        metadata: {
          resourceType: "task",
          projectId,
          jobId: job.id,
          source: "job-management",
        },
      } as NewLedgerEntry);

      revalidatePath(`/jobs/${job.id}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);

      return { success: true, message: "Task added.", resourceId: createdTask.id } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to add the task." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: "task_added", jobId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Task added." };
}
