"use server";

/**
 * Personal calendar work items (2026-07-10): the viewer's COMPLETED
 * workperiods (start → stop sessions from the job timer) and their claimed
 * jobs' work windows (startDate → deadline). Feeds the /calendar filters
 * "Work periods" and "My jobs".
 *
 * Viewer-scoped via the unified resolver (local session, remote-viewer
 * cookie, or MCP execution context) so sovereign-homed and federated workers
 * see their own work.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";

export interface WorkPeriodCalendarItem {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
}

export interface JobWindowCalendarItem {
  id: string;
  name: string;
  startDate: string | null;
  deadline: string | null;
}

export interface MyWorkCalendarData {
  workPeriods: WorkPeriodCalendarItem[];
  jobs: JobWindowCalendarItem[];
}

/** Upper bound on returned rows — a personal calendar, not an export. */
const MAX_ITEMS = 500;

export interface GroupWorkPeriodItem {
  id: string;
  jobId: string;
  jobName: string;
  workerId: string;
  workerName: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
}

/**
 * ADMIN-GATED: completed workperiods across a group subtree's jobs, for the
 * group calendar's "Work periods" kind (filterable by person via the member
 * filter). Non-admin viewers get an empty list — the gate lives HERE, not in
 * the client filter (client filters are not a privacy boundary).
 */
export async function getGroupWorkPeriods(groupId: string): Promise<GroupWorkPeriodItem[]> {
  const userId = await getCurrentUserId();
  if (!userId || !groupId) return [];

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  if (!(await hasGroupWriteAccess(userId, groupId))) return [];

  const rows = (await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id FROM agents a JOIN grp_tree t ON a.parent_id = t.id WHERE a.deleted_at IS NULL
    )
    SELECT wp.id,
           job.id AS job_id,
           job.name AS job_name,
           wp.owner_id AS worker_id,
           COALESCE(worker.name, 'Member') AS worker_name,
           wp.metadata->>'startedAt' AS started_at,
           wp.metadata->>'stoppedAt' AS stopped_at,
           COALESCE((wp.metadata->>'durationMs')::bigint, 0) AS duration_ms
    FROM resources wp
    JOIN resources job ON job.id = (wp.metadata->>'jobId')::uuid
      AND job.type = 'job' AND job.deleted_at IS NULL
      AND job.owner_id IN (SELECT id FROM grp_tree)
    LEFT JOIN agents worker ON worker.id = wp.owner_id AND worker.deleted_at IS NULL
    WHERE wp.type = 'resource'
      AND wp.deleted_at IS NULL
      AND wp.metadata->>'resourceKind' = 'workperiod'
      AND wp.metadata->>'stoppedAt' IS NOT NULL
    ORDER BY wp.metadata->>'startedAt' DESC
    LIMIT ${MAX_ITEMS}
  `)) as Array<Record<string, unknown>>;

  return rows
    .map((row) => ({
      id: String(row.id ?? ""),
      jobId: String(row.job_id ?? ""),
      jobName: String(row.job_name ?? "Job"),
      workerId: String(row.worker_id ?? ""),
      workerName: String(row.worker_name ?? "Member"),
      startedAt: String(row.started_at ?? ""),
      stoppedAt: String(row.stopped_at ?? ""),
      durationMs: Number(row.duration_ms ?? 0),
    }))
    .filter((p) => p.id && p.startedAt && p.stoppedAt);
}

/**
 * Returns the signed-in viewer's completed workperiods and claimed-job work
 * windows for calendar display. Empty sets when signed out.
 */
export async function getMyWorkCalendarItems(): Promise<MyWorkCalendarData> {
  const userId = await getCurrentUserId();
  if (!userId) return { workPeriods: [], jobs: [] };

  const periodRows = (await db.execute(sql`
    SELECT wp.id,
           wp.metadata->>'jobId' AS job_id,
           COALESCE(job.name, 'Job') AS job_name,
           wp.metadata->>'startedAt' AS started_at,
           wp.metadata->>'stoppedAt' AS stopped_at,
           COALESCE((wp.metadata->>'durationMs')::bigint, 0) AS duration_ms
    FROM resources wp
    LEFT JOIN resources job ON job.id = (wp.metadata->>'jobId')::uuid AND job.deleted_at IS NULL
    WHERE wp.type = 'resource'
      AND wp.deleted_at IS NULL
      AND wp.owner_id = ${userId}::uuid
      AND wp.metadata->>'resourceKind' = 'workperiod'
      AND wp.metadata->>'stoppedAt' IS NOT NULL
    ORDER BY wp.metadata->>'startedAt' DESC
    LIMIT ${MAX_ITEMS}
  `)) as Array<Record<string, unknown>>;

  const workPeriods: WorkPeriodCalendarItem[] = periodRows
    .map((row) => ({
      id: String(row.id ?? ""),
      jobId: String(row.job_id ?? ""),
      jobName: String(row.job_name ?? "Job"),
      startedAt: String(row.started_at ?? ""),
      stoppedAt: String(row.stopped_at ?? ""),
      durationMs: Number(row.duration_ms ?? 0),
    }))
    .filter((p) => p.id && p.startedAt && p.stoppedAt);

  // Jobs the viewer holds an active claim on, with any work window fields.
  const jobRows = (await db.execute(sql`
    SELECT DISTINCT job.id,
           job.name,
           job.metadata->>'startDate' AS start_date,
           job.metadata->>'deadline' AS deadline
    FROM ledger l
    JOIN resources job ON job.id = (l.metadata->>'targetId')::uuid
      AND job.type = 'job' AND job.deleted_at IS NULL
    WHERE l.subject_id = ${userId}::uuid
      AND l.verb = 'join'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = 'job-claim'
    LIMIT ${MAX_ITEMS}
  `)) as Array<Record<string, unknown>>;

  const jobs: JobWindowCalendarItem[] = jobRows
    .map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? "Job"),
      startDate: row.start_date ? String(row.start_date) : null,
      deadline: row.deadline ? String(row.deadline) : null,
    }))
    .filter((j) => j.id && (j.startDate || j.deadline));

  return { workPeriods, jobs };
}
