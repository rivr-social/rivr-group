"use server";

/**
 * Job QA / admin review rail (2026-07-13).
 *
 * The attester's review surface on the job detail page. Three capabilities,
 * all authority-gated server-side against the job RESOURCE's owning agent
 * (`resources.owner_id`) — the exact node the completion/attestation actions
 * enforce against, resolved through the remote-viewer-aware unified session
 * (NOT plain `auth()`), so a federated SSO-landed admin keeps their controls:
 *
 * 1. `getJobQaReviewData` — per-assignee recorded work periods (current
 *    `workperiod` resources AND legacy `time_entry` ledger rows — the two
 *    timer rails `getTrackedMsForAssignee` reads), their claim-complete
 *    ratings / proposed points, their attested points, and the DISCREPANCIES
 *    between claimed and recorded/attested values (directive #3).
 * 2. `editWorkPeriodDurationAction` — corrects a recorded period's duration
 *    (admins on any row; a worker on their own), stamping an audit trail
 *    (`editedBy`/`editedAt`/`previousDurationMs`) onto the row metadata.
 * 3. `setAttestedPointsAction` — (re)settles a worker's points on a task or
 *    the job THROUGH `attestWork`, the single writer of the
 *    `task-points-earned` stake edge. Points are never written here directly.
 *
 * Invariants preserved: points move ONLY through `@/lib/work-completion`
 * (`attestWork`); time edits never touch the points rail. Authority for
 * point edits is `canAttestWork` (project QA/lead or group/ancestor admin),
 * never a bare membership check.
 */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import { getAuthenticatedActorId } from "@/lib/server-auth";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";
import { TASK_POINTS_INTERACTION } from "@/lib/queries/stakes";
import {
  WORK_COMPLETION_CLAIM_INTERACTION,
  resolveProjectAuthority,
  canAttestWork,
  attestWork,
  type WorkTargetRef,
} from "@/lib/work-completion";

// ─── Constants ────────────────────────────────────────────────────────────

/** resourceKind discriminator for workperiod records (mirrors job-timer.ts). */
const WORKPERIOD_KIND = "workperiod";

/** Legacy ledger timer shape (pre-workperiod). */
const LEGACY_TIMER_VERB = "work";
const LEGACY_TIMER_INTERACTION_TYPE = "time_entry";

/** Job resource types accepted (current + legacy). */
const JOB_RESOURCE_TYPES = ["job", "shift"] as const;

const MS_PER_HOUR = 3_600_000;

/** Upper bound on an edited period (1 year) — guards against overflow/typos. */
const MAX_WORKPERIOD_MS = 365 * 24 * MS_PER_HOUR;

/** Upper bound on a manually attested point value. */
const MAX_ATTESTED_POINTS = 1_000_000;

// ─── Types ────────────────────────────────────────────────────────────────

export type WorkPeriodSource = "workperiod" | "legacy";

export interface JobWorkPeriodRow {
  id: string;
  source: WorkPeriodSource;
  taskId: string | null;
  taskName: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number;
  running: boolean;
  /** Audit stamp when an admin/worker corrected the duration. */
  editedBy: string | null;
  editedAt: string | null;
  previousDurationMs: number | null;
}

export interface JobAssigneeTaskReview {
  taskId: string;
  taskName: string;
  taskPoints: number;
  claimStatus: string | null;
  proposedPoints: number | null;
  attestedPoints: number | null;
}

export type JobDiscrepancyKind =
  | "claimed_no_time"
  | "proposed_vs_attested"
  | "claimed_unattested"
  | "time_over_budget";

export interface JobDiscrepancy {
  kind: JobDiscrepancyKind;
  message: string;
}

export interface JobAssigneeReview {
  assigneeId: string;
  assigneeName: string;
  workPeriods: JobWorkPeriodRow[];
  trackedMs: number;
  jobClaimStatus: string | null;
  claimSkillfulness: number | null;
  claimDifficulty: number | null;
  jobProposedPoints: number | null;
  jobAttestedPoints: number | null;
  tasks: JobAssigneeTaskReview[];
  totalAttestedPoints: number;
  discrepancies: JobDiscrepancy[];
}

export interface JobQaReviewData {
  jobId: string;
  jobName: string;
  ownerId: string;
  payKind: "fixed" | "hourly" | "volunteer" | null;
  maxHours: number | null;
  viewerId: string;
  canManage: boolean;
  canAttest: boolean;
  assignees: JobAssigneeReview[];
}

// ─── Session + authority ────────────────────────────────────────────────────

/**
 * Remote-viewer-aware viewer id: the unified session (local/federated/MCP),
 * falling back to the raw SSO remote-viewer cookie so an SSO-landed admin who
 * holds only that cookie still resolves (mirrors the job page).
 */
async function resolveViewerId(): Promise<string | null> {
  return (await getCurrentUserId()) ?? (await getAuthenticatedActorId());
}

interface JobAuthority {
  viewerId: string;
  ownerId: string;
  jobName: string;
  jobMeta: Record<string, unknown>;
  canManage: boolean;
  canAttest: boolean;
}

/** Loads a live job row (current or legacy type). */
async function loadJob(jobId: string) {
  const [job] = await db
    .select({ id: resources.id, name: resources.name, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(
      and(eq(resources.id, jobId), inArray(resources.type, [...JOB_RESOURCE_TYPES]), isNull(resources.deletedAt)),
    )
    .limit(1);
  return job ?? null;
}

/**
 * Resolves the viewer's authority over a job: `canManage` (owner OR group
 * write access on the OWNING agent, cascading via `isGroupAdmin`) and
 * `canAttest` (that PLUS the project lead/QA). Returns null when the job is
 * missing or the viewer holds neither.
 */
async function resolveJobAuthority(jobId: string): Promise<JobAuthority | null> {
  const viewerId = await resolveViewerId();
  if (!viewerId) return null;
  const job = await loadJob(jobId);
  if (!job) return null;

  const jobMeta = (job.metadata ?? {}) as Record<string, unknown>;
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const canManage = job.ownerId === viewerId || (await hasGroupWriteAccess(viewerId, job.ownerId));

  let canAttest = canManage;
  if (!canAttest) {
    const authority = await resolveProjectAuthority({
      targetType: "job",
      jobId,
      projectId: typeof jobMeta.projectId === "string" ? jobMeta.projectId : null,
    });
    canAttest = await canAttestWork(viewerId, job.ownerId, authority);
  }

  if (!canManage && !canAttest) return null;
  return { viewerId, ownerId: job.ownerId, jobName: job.name, jobMeta, canManage, canAttest };
}

// ─── Read: review data ──────────────────────────────────────────────────────

/** DISTINCT active job-claim holders (+ legacy embedded assignees fallback). */
async function getAssigneeIds(jobId: string, jobMeta: Record<string, unknown>): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT subject_id::text AS id FROM ledger
    WHERE verb = 'join' AND is_active = true
      AND metadata->>'interactionType' = 'job-claim'
      AND metadata->>'targetId' = ${jobId}
  `)) as Array<{ id: string }>;
  const claimants = rows.map((r) => r.id).filter(Boolean);
  if (claimants.length > 0) return claimants.sort();
  return Array.isArray(jobMeta.assignees)
    ? jobMeta.assignees.filter((a): a is string => typeof a === "string").sort()
    : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Everything the admin review panel needs for a job, keyed by assignee.
 * Returns null when the viewer may neither manage nor attest the job.
 */
export async function getJobQaReviewData(jobId: string): Promise<JobQaReviewData | null> {
  if (!isUuid(jobId)) return null;
  const authority = await resolveJobAuthority(jobId);
  if (!authority) return null;
  const { viewerId, ownerId, jobName, jobMeta, canManage, canAttest } = authority;

  const assigneeIds = await getAssigneeIds(jobId, jobMeta);

  // Job's tasks (points + names live here).
  const taskRows = await db
    .select({ id: resources.id, name: resources.name, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, "task"),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->>'jobId' = ${jobId}`,
      ),
    );
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const taskIds = taskRows.map((t) => t.id);
  const claimTargetIds = [jobId, ...taskIds];

  // Assignee display names.
  const nameById = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const nameRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(inArray(agents.id, assigneeIds), isNull(agents.deletedAt)));
    for (const r of nameRows) nameById.set(r.id, r.name);
  }

  // Work periods (current rail) for the job, grouped by owner.
  const wpRows = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
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

  // Legacy timer rows (pre-workperiod), grouped by subject.
  const legacyRows = (await db.execute(sql`
    SELECT id::text AS id, subject_id::text AS subject_id, metadata
    FROM ledger
    WHERE verb = ${LEGACY_TIMER_VERB}
      AND object_id = ${jobId}::uuid
      AND is_active = true
      AND metadata->>'interactionType' = ${LEGACY_TIMER_INTERACTION_TYPE}
      AND metadata->>'durationMs' IS NOT NULL
    ORDER BY timestamp DESC
  `)) as Array<{ id: string; subject_id: string; metadata: Record<string, unknown> }>;

  // Latest claim per (worker, target) across the job + its tasks.
  const claimRows = (await db.execute(sql`
    SELECT subject_id::text AS subject_id, object_id::text AS object_id, is_active, metadata, timestamp
    FROM ledger
    WHERE verb = 'complete'
      AND metadata->>'interactionType' = ${WORK_COMPLETION_CLAIM_INTERACTION}
      AND metadata->>'jobId' = ${jobId}
    ORDER BY timestamp DESC
  `)) as Array<{ subject_id: string; object_id: string; is_active: boolean; metadata: Record<string, unknown> }>;
  const latestClaim = new Map<string, { active: boolean; meta: Record<string, unknown> }>();
  for (const row of claimRows) {
    const key = `${row.subject_id}:${row.object_id}`;
    if (!latestClaim.has(key)) latestClaim.set(key, { active: row.is_active === true, meta: row.metadata ?? {} });
  }

  // Active attested-points edges per (worker, target).
  const pointsByKey = new Map<string, number>();
  if (claimTargetIds.length > 0) {
    const pointRows = await db
      .select({ subjectId: ledger.subjectId, objectId: ledger.objectId, metadata: ledger.metadata })
      .from(ledger)
      .where(
        and(
          eq(ledger.verb, "earn"),
          eq(ledger.isActive, true),
          inArray(ledger.objectId, claimTargetIds),
          sql`${ledger.metadata}->>'interactionType' = ${TASK_POINTS_INTERACTION}`,
        ),
      );
    for (const row of pointRows) {
      const pts = num((row.metadata as Record<string, unknown>)?.points);
      if (pts !== null) pointsByKey.set(`${row.subjectId}:${row.objectId}`, pts);
    }
  }

  const maxHours = num(jobMeta.maxHours) && (num(jobMeta.maxHours) as number) > 0 ? (num(jobMeta.maxHours) as number) : null;
  const payKind =
    jobMeta.payKind === "fixed" || jobMeta.payKind === "hourly" || jobMeta.payKind === "volunteer"
      ? jobMeta.payKind
      : null;

  const assignees: JobAssigneeReview[] = assigneeIds.map((assigneeId) => {
    // Work periods for this assignee.
    const workPeriods: JobWorkPeriodRow[] = [];
    for (const row of wpRows.filter((w) => w.ownerId === assigneeId)) {
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const stoppedAt = typeof m.stoppedAt === "string" ? m.stoppedAt : null;
      const taskId = typeof m.taskId === "string" ? m.taskId : null;
      workPeriods.push({
        id: row.id,
        source: "workperiod",
        taskId,
        taskName: taskId ? taskById.get(taskId)?.name ?? null : null,
        startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
        stoppedAt,
        durationMs: num(m.durationMs) ?? 0,
        running: stoppedAt === null,
        editedBy: typeof m.durationEditedBy === "string" ? m.durationEditedBy : null,
        editedAt: typeof m.durationEditedAt === "string" ? m.durationEditedAt : null,
        previousDurationMs: num(m.previousDurationMs),
      });
    }
    for (const row of legacyRows.filter((l) => l.subject_id === assigneeId)) {
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const taskId = typeof m.taskId === "string" ? m.taskId : null;
      workPeriods.push({
        id: row.id,
        source: "legacy",
        taskId,
        taskName: taskId ? taskById.get(taskId)?.name ?? null : null,
        startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
        stoppedAt: typeof m.stoppedAt === "string" ? m.stoppedAt : null,
        durationMs: num(m.durationMs) ?? 0,
        running: false,
        editedBy: typeof m.durationEditedBy === "string" ? m.durationEditedBy : null,
        editedAt: typeof m.durationEditedAt === "string" ? m.durationEditedAt : null,
        previousDurationMs: num(m.previousDurationMs),
      });
    }
    const trackedMs = workPeriods.reduce((sum, p) => sum + p.durationMs, 0);

    // Job-level claim + attested points.
    const jobClaim = latestClaim.get(`${assigneeId}:${jobId}`);
    const jobClaimMeta = jobClaim?.meta ?? {};
    const jobClaimStatus = jobClaim
      ? jobClaim.active
        ? typeof jobClaimMeta.reviewStatus === "string"
          ? jobClaimMeta.reviewStatus
          : "claimed"
        : "rejected"
      : null;
    const jobAttestedPoints = pointsByKey.get(`${assigneeId}:${jobId}`) ?? null;

    // Per-task claim + attested points.
    const tasks: JobAssigneeTaskReview[] = taskRows.map((t) => {
      const claim = latestClaim.get(`${assigneeId}:${t.id}`);
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      return {
        taskId: t.id,
        taskName: t.name,
        taskPoints: num(meta.points) ?? 0,
        claimStatus: claim ? (claim.active ? String((claim.meta.reviewStatus as string) ?? "claimed") : "rejected") : null,
        proposedPoints: claim ? num(claim.meta.proposedPoints) : null,
        attestedPoints: pointsByKey.get(`${assigneeId}:${t.id}`) ?? null,
      };
    });

    const totalAttestedPoints =
      (jobAttestedPoints ?? 0) + tasks.reduce((sum, t) => sum + (t.attestedPoints ?? 0), 0);

    // ── Discrepancies (directive #3) ──
    const discrepancies: JobDiscrepancy[] = [];
    const activelyClaimed =
      jobClaimStatus === "claimed" || tasks.some((t) => t.claimStatus === "claimed");
    if (activelyClaimed && trackedMs === 0) {
      discrepancies.push({
        kind: "claimed_no_time",
        message: "Claimed finished with 0 tracked time.",
      });
    }
    if (maxHours !== null && trackedMs > maxHours * MS_PER_HOUR) {
      const over = (trackedMs - maxHours * MS_PER_HOUR) / MS_PER_HOUR;
      discrepancies.push({
        kind: "time_over_budget",
        message: `Tracked ${over.toFixed(1)}h over the ${maxHours}h budget.`,
      });
    }
    if (jobClaimStatus === "claimed") {
      discrepancies.push({ kind: "claimed_unattested", message: "Job claim awaiting your attestation." });
    }
    for (const t of tasks) {
      if (t.claimStatus === "claimed") {
        discrepancies.push({
          kind: "claimed_unattested",
          message: `"${t.taskName}" claimed — awaiting attestation.`,
        });
      }
      if (
        t.proposedPoints !== null &&
        t.attestedPoints !== null &&
        t.proposedPoints !== t.attestedPoints
      ) {
        discrepancies.push({
          kind: "proposed_vs_attested",
          message: `"${t.taskName}": proposed ${t.proposedPoints}, attested ${t.attestedPoints}.`,
        });
      }
    }

    return {
      assigneeId,
      assigneeName: nameById.get(assigneeId) ?? assigneeId.slice(0, 8),
      workPeriods,
      trackedMs,
      jobClaimStatus,
      claimSkillfulness: num(jobClaimMeta.skillfulness),
      claimDifficulty: num(jobClaimMeta.difficulty),
      jobProposedPoints: num(jobClaimMeta.proposedPoints),
      jobAttestedPoints,
      tasks,
      totalAttestedPoints,
      discrepancies,
    };
  });

  return { jobId, jobName, ownerId, payKind, maxHours, viewerId, canManage, canAttest, assignees };
}

// ─── Write: edit a recorded work period's duration ──────────────────────────

export interface EditWorkPeriodInput {
  workPeriodId: string;
  source: WorkPeriodSource;
  /** New recorded duration in milliseconds (>= 0). */
  durationMs: number;
}

/**
 * Corrects the recorded duration of a work period. Admins may edit any row on
 * the job; a worker may edit their OWN row. The prior value is preserved on
 * the row metadata (`previousDurationMs`) with an `editedBy`/`editedAt` stamp.
 * Does not touch the points rail — hourly pay re-reads the corrected duration
 * at the next mark-done.
 */
export async function editWorkPeriodDurationAction(input: EditWorkPeriodInput): Promise<ActionResult> {
  const viewerId = await resolveViewerId();
  if (!viewerId) return { success: false, message: "You must be logged in to edit a work period." };
  if (!isUuid(input.workPeriodId)) return { success: false, message: "Invalid work-period id." };

  const durationMs = Math.round(Number(input.durationMs));
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return { success: false, message: "Duration must be a non-negative number of milliseconds." };
  }
  if (durationMs > MAX_WORKPERIOD_MS) {
    return { success: false, message: "Duration exceeds the maximum allowed." };
  }

  const check = await rateLimit(`social:${viewerId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const now = new Date().toISOString();

  if (input.source === "workperiod") {
    const [row] = await db
      .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
      .from(resources)
      .where(
        and(
          eq(resources.id, input.workPeriodId),
          eq(resources.type, "resource"),
          isNull(resources.deletedAt),
          sql`${resources.metadata}->>'resourceKind' = ${WORKPERIOD_KIND}`,
        ),
      )
      .limit(1);
    if (!row) return { success: false, message: "Work period not found." };

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.stoppedAt !== "string") {
      return { success: false, message: "Stop the running timer before editing its duration." };
    }
    const jobId = typeof meta.jobId === "string" ? meta.jobId : null;
    if (!(await mayEditPeriod(viewerId, row.ownerId, jobId))) {
      return { success: false, message: "You do not have permission to edit this work period." };
    }

    const previousDurationMs = num(meta.durationMs) ?? 0;
    await db
      .update(resources)
      .set({
        metadata: {
          ...meta,
          durationMs,
          previousDurationMs,
          durationEditedBy: viewerId,
          durationEditedAt: now,
        },
        updatedAt: new Date(),
      })
      .where(eq(resources.id, input.workPeriodId));
    if (jobId) revalidatePath(`/jobs/${jobId}`);
    return { success: true, message: "Work period updated." };
  }

  // Legacy `time_entry` ledger row.
  const rows = (await db.execute(sql`
    SELECT subject_id::text AS subject_id, object_id::text AS object_id, metadata
    FROM ledger
    WHERE id = ${input.workPeriodId}::uuid
      AND verb = ${LEGACY_TIMER_VERB}
      AND metadata->>'interactionType' = ${LEGACY_TIMER_INTERACTION_TYPE}
    LIMIT 1
  `)) as Array<{ subject_id: string; object_id: string; metadata: Record<string, unknown> }>;
  const legacy = rows[0];
  if (!legacy) return { success: false, message: "Work period not found." };
  const meta = legacy.metadata ?? {};
  const jobId = legacy.object_id;
  if (!(await mayEditPeriod(viewerId, legacy.subject_id, jobId))) {
    return { success: false, message: "You do not have permission to edit this work period." };
  }
  const previousDurationMs = num(meta.durationMs) ?? 0;
  const nextMeta = { ...meta, durationMs, previousDurationMs, durationEditedBy: viewerId, durationEditedAt: now };
  await db.execute(sql`
    UPDATE ledger SET metadata = ${JSON.stringify(nextMeta)}::jsonb
    WHERE id = ${input.workPeriodId}::uuid
  `);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { success: true, message: "Work period updated." };
}

/** Whether the viewer may edit a period: its own worker, or a job admin. */
async function mayEditPeriod(viewerId: string, workerId: string, jobId: string | null): Promise<boolean> {
  if (viewerId === workerId) return true;
  if (!jobId) return false;
  const auth = await resolveJobAuthority(jobId);
  return Boolean(auth && (auth.canManage || auth.canAttest));
}

// ─── Write: (re)set a worker's attested points ──────────────────────────────

export interface SetAttestedPointsInput {
  targetId: string;
  targetType: "task" | "job";
  workerId: string;
  /** Point value to award (>= 0). Zero clears the award. */
  points: number;
}

/**
 * (Re)settles a worker's attested points on a task or the job. Routes through
 * `attestWork` — the SINGLE writer of the `task-points-earned` edge — so the
 * stake rail stays consistent (re-attestation updates the one active edge in
 * place; zero awards nothing). Gated by `canAttestWork` (project QA/lead or
 * group/ancestor admin), never a bare membership check.
 */
export async function setAttestedPointsAction(input: SetAttestedPointsInput): Promise<ActionResult> {
  const viewerId = await resolveViewerId();
  if (!viewerId) return { success: false, message: "You must be logged in to attest points." };
  if (!isUuid(input.targetId) || !isUuid(input.workerId)) {
    return { success: false, message: "Invalid target or worker id." };
  }
  if (input.targetType !== "task" && input.targetType !== "job") {
    return { success: false, message: "Invalid target type." };
  }
  const points = Math.round(Number(input.points));
  if (!Number.isFinite(points) || points < 0 || points > MAX_ATTESTED_POINTS) {
    return { success: false, message: "Points must be a non-negative number within range." };
  }

  const check = await rateLimit(`social:${viewerId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  // Load the target for its owning agent + job/project linkage.
  const [target] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, type: resources.type, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, input.targetId), isNull(resources.deletedAt)))
    .limit(1);
  if (!target) return { success: false, message: "Target not found." };

  const meta = (target.metadata ?? {}) as Record<string, unknown>;
  const jobId =
    input.targetType === "job" ? input.targetId : typeof meta.jobId === "string" ? meta.jobId : null;
  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;
  const ref: WorkTargetRef = {
    targetId: input.targetId,
    targetType: input.targetType,
    ownerId: target.ownerId,
    jobId,
    projectId,
  };

  const authority = await resolveProjectAuthority(ref);
  if (!(await canAttestWork(viewerId, target.ownerId, authority))) {
    return {
      success: false,
      message: "Only the project QA, project lead, or a group admin can attest points.",
    };
  }

  // The single writer. A positive value verifies and (re)activates the one
  // points edge in place; zero is a rejection — the only attestWork path that
  // DEACTIVATES the points edge (a bare verified+0 would leave a prior award
  // active), which is the correct "clear the award" semantics.
  const outcome = points > 0 ? "verified" : "rejected";
  const { awardedPoints } = await attestWork({
    verifierId: viewerId,
    workerId: input.workerId,
    ref,
    points,
    outcome,
  });

  revalidatePath(`/jobs/${jobId ?? input.targetId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);

  return {
    success: true,
    message: awardedPoints > 0 ? `Attested ${awardedPoints} points.` : "Attested points cleared.",
  };
}
