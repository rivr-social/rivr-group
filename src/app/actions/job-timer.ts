"use server";

/**
 * Job work-timer → first-class WORKPERIOD records (2026-07-07 sprint).
 *
 * Pressing play on a job creates a `workperiod` resource — a persisted record
 * of one work session (worker + job + optional task, start → stop → duration).
 * Work periods are the source of truth for hourly-rate payout
 * (markJobDoneAction sums their durations) and the job timesheet. They are
 * first-class `resource` rows (metadata.resourceKind = 'workperiod') so they
 * survive reloads, are queryable, and can be surfaced/managed like tasks —
 * the previous timer kept everything in ephemeral client state and persisted
 * nothing.
 *
 * Legacy `time_entry` ledger rows (the old server timer) are still summed in
 * the read/total/payout paths so historical tracked time is not lost.
 */

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";

// ─── Constants ──────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** resourceKind discriminator for workperiod records. */
const WORKPERIOD_KIND = "workperiod";

/** Legacy ledger timer shape (pre-workperiod) — still read for back-compat. */
const LEGACY_TIMER_VERB = "work" as const;
const LEGACY_TIMER_INTERACTION_TYPE = "time_entry";

// ─── Result Types ───────────────────────────────────────────────────────────

interface TimerStartResult {
  success: boolean;
  message: string;
  /** The created workperiod resource id. */
  workPeriodId?: string;
}

interface TimerStopResult {
  success: boolean;
  message: string;
  durationMs?: number;
  tasksCompletedDuringPeriod?: string[];
}

export interface WorkPeriodRecord {
  id: string;
  jobId: string;
  taskId: string | null;
  workerId: string;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  status: "running" | "completed";
}

interface TimerStatusResult {
  success: boolean;
  message: string;
  activeTimer: WorkPeriodRecord | null;
  totalTimeMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getAuthUserId(): Promise<string | null> {
  // Unified session (local, remote-viewer, or MCP execution context) so
  // sovereign-homed workers can time their work; lazy import avoids circular deps.
  const { getCurrentUserId } = await import("@/app/actions/interactions/helpers");
  return getCurrentUserId();
}

/** Maps a workperiod resource row to the domain record. */
function rowToWorkPeriod(row: { id: string; ownerId: string; metadata: unknown }): WorkPeriodRecord {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const stoppedAt = typeof m.stoppedAt === "string" ? m.stoppedAt : null;
  return {
    id: row.id,
    jobId: typeof m.jobId === "string" ? m.jobId : "",
    taskId: typeof m.taskId === "string" ? m.taskId : null,
    workerId: typeof m.workerId === "string" ? m.workerId : row.ownerId,
    startedAt: typeof m.startedAt === "string" ? m.startedAt : "",
    stoppedAt,
    durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
    status: stoppedAt === null ? "running" : "completed",
  };
}

/** Loads the caller's workperiod resources for a job (running first). */
async function getWorkPeriodsForUserJob(userId: string, jobId: string): Promise<
  Array<{ id: string; ownerId: string; metadata: unknown }>
> {
  return db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, "resource"),
        eq(resources.ownerId, userId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->>'resourceKind' = ${WORKPERIOD_KIND}`,
        sql`${resources.metadata}->>'jobId' = ${jobId}`,
      ),
    );
}

/** Sum of legacy `time_entry` ledger durations for a job (optionally one user). */
async function legacyTrackedMs(jobId: string, userId?: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'durationMs')::bigint), 0) AS total_ms
    FROM ledger
    WHERE verb = ${LEGACY_TIMER_VERB}
      AND object_id = ${jobId}::uuid
      AND is_active = true
      AND metadata->>'interactionType' = ${LEGACY_TIMER_INTERACTION_TYPE}
      AND metadata->>'durationMs' IS NOT NULL
      ${userId ? sql`AND subject_id = ${userId}::uuid` : sql``}
  `)) as Array<Record<string, unknown>>;
  return Number(rows[0]?.total_ms ?? 0);
}

// ─── Server Actions ─────────────────────────────────────────────────────────

/**
 * Starts a work timer on a job — creates a `workperiod` record for the caller.
 * Only one running work period per user per job is allowed. Optionally scoped
 * to a specific task (the timer's task picker).
 */
export async function startJobTimer(jobId: string, taskId?: string): Promise<TimerStartResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to start a timer." };
  }
  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID." };
  }
  const scopedTaskId = taskId && UUID_PATTERN.test(taskId) ? taskId : null;

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  // One running work period per user per job.
  const periods = await getWorkPeriodsForUserJob(userId, jobId);
  const running = periods.find((p) => rowToWorkPeriod(p).status === "running");
  if (running) {
    return { success: false, message: "A timer is already running on this job." };
  }

  // Read the job for the project/group linkage stamped onto the record.
  const [job] = await db
    .select({ id: resources.id, name: resources.name, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, jobId), isNull(resources.deletedAt)))
    .limit(1);
  if (!job) {
    return { success: false, message: "Job not found." };
  }
  const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
  const startedAt = new Date().toISOString();

  const [created] = await db
    .insert(resources)
    .values({
      name: `Work period — ${job.name}`,
      type: "resource",
      ownerId: userId,
      visibility: "private",
      metadata: {
        resourceKind: WORKPERIOD_KIND,
        jobId,
        taskId: scopedTaskId,
        projectId: typeof jobMeta.projectId === "string" ? jobMeta.projectId : null,
        groupId: typeof jobMeta.groupId === "string" ? jobMeta.groupId : job.ownerId,
        workerId: userId,
        startedAt,
        stoppedAt: null,
        durationMs: null,
        status: "running",
      },
    } as NewResource)
    .returning({ id: resources.id });

  // Provenance edge (keeps the ledger interaction history intact).
  await db.insert(ledger).values({
    subjectId: userId,
    verb: LEGACY_TIMER_VERB,
    objectId: jobId,
    objectType: "resource",
    resourceId: created.id,
    metadata: {
      interactionType: "workperiod-started",
      workPeriodId: created.id,
      jobId,
      taskId: scopedTaskId,
      startedAt,
    },
  } as NewLedgerEntry);

  revalidatePath(`/jobs/${jobId}`);

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: "resource",
    entityId: created.id,
    actorId: userId,
    payload: { action: "workperiod_started", jobId, workPeriodId: created.id },
  }).catch(() => {});

  return { success: true, message: "Timer started.", workPeriodId: created.id };
}

/**
 * Stops the running work period on a job for the caller — stamps stoppedAt +
 * durationMs and closes the record.
 */
export async function stopJobTimer(
  jobId: string,
  completedTaskIds: string[] = [],
): Promise<TimerStopResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to stop a timer." };
  }
  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  const periods = await getWorkPeriodsForUserJob(userId, jobId);
  const runningRow = periods.find((p) => rowToWorkPeriod(p).status === "running");
  if (!runningRow) {
    return { success: false, message: "No running timer found for this job." };
  }

  const meta = (runningRow.metadata ?? {}) as Record<string, unknown>;
  const startedAt = typeof meta.startedAt === "string" ? meta.startedAt : new Date().toISOString();
  const now = new Date();
  const stoppedAt = now.toISOString();
  const durationMs = Math.max(0, now.getTime() - new Date(startedAt).getTime());
  const validTaskIds = completedTaskIds.filter((id) => UUID_PATTERN.test(id));

  await db
    .update(resources)
    .set({
      metadata: {
        ...meta,
        stoppedAt,
        durationMs,
        status: "completed",
        tasksCompletedDuringPeriod: validTaskIds,
      },
      updatedAt: new Date(),
    })
    .where(eq(resources.id, runningRow.id));

  revalidatePath(`/jobs/${jobId}`);

  return {
    success: true,
    message: "Timer stopped.",
    durationMs,
    tasksCompletedDuringPeriod: validTaskIds,
  };
}

/**
 * Returns the caller's timer status for a job: the running work period (if any)
 * and total tracked time across their completed work periods (+ legacy entries).
 */
export async function getJobTimerStatus(jobId: string): Promise<TimerStatusResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "Not authenticated.", activeTimer: null, totalTimeMs: 0 };
  }
  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID.", activeTimer: null, totalTimeMs: 0 };
  }

  const periods = (await getWorkPeriodsForUserJob(userId, jobId)).map(rowToWorkPeriod);
  const activeTimer = periods.find((p) => p.status === "running") ?? null;
  const workPeriodMs = periods
    .filter((p) => p.status === "completed" && p.durationMs !== null)
    .reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
  const totalTimeMs = workPeriodMs + (await legacyTrackedMs(jobId, userId));

  return {
    success: true,
    message: activeTimer ? "Timer is running." : "No active timer.",
    activeTimer,
    totalTimeMs,
  };
}

/**
 * Lists all work-period records on a job (every worker), newest first. Powers
 * the job timesheet and the admin work-period review surface.
 */
export async function listJobWorkPeriods(jobId: string): Promise<WorkPeriodRecord[]> {
  if (!UUID_PATTERN.test(jobId)) return [];
  const rows = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata, createdAt: resources.createdAt })
    .from(resources)
    .where(
      and(
        eq(resources.type, "resource"),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->>'resourceKind' = ${WORKPERIOD_KIND}`,
        sql`${resources.metadata}->>'jobId' = ${jobId}`,
      ),
    )
    .orderBy(sql`${resources.createdAt} DESC`);
  return rows.map(rowToWorkPeriod);
}

/**
 * Returns aggregate tracked time (ms) for a job across ALL workers — completed
 * work periods plus legacy timer entries. Used in the project/job headers.
 */
export async function getJobTotalTime(jobId: string): Promise<number> {
  if (!UUID_PATTERN.test(jobId)) return 0;
  const rows = (await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'durationMs')::bigint), 0) AS total_ms
    FROM resources
    WHERE type = 'resource'
      AND deleted_at IS NULL
      AND metadata->>'resourceKind' = ${WORKPERIOD_KIND}
      AND metadata->>'jobId' = ${jobId}
      AND metadata->>'durationMs' IS NOT NULL
  `)) as Array<Record<string, unknown>>;
  const workPeriodMs = Number(rows[0]?.total_ms ?? 0);
  return workPeriodMs + (await legacyTrackedMs(jobId));
}
