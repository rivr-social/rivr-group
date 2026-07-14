/**
 * DB tests for the job QA / admin review rail (`@/app/actions/job-qa`):
 * authority-gated review data (recorded work periods across BOTH timer rails,
 * claim vs attested points, discrepancy detection), inline duration edits with
 * an audit stamp, and attested-point (re)settlement that routes through the
 * attestation single-writer.
 *
 * Run with `pnpm test:db`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestLedgerEntry,
  createMembership,
} from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: { SOCIAL: { limit: 100, windowMs: 60_000 }, WALLET: { limit: 100, windowMs: 60_000 } },
}));

const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

// SSO remote-viewer fallback resolves to nothing in tests — viewer comes from
// the mocked unified session above.
vi.mock("@/lib/server-auth", () => ({ getAuthenticatedActorId: vi.fn().mockResolvedValue(null) }));

import {
  getJobQaReviewData,
  editWorkPeriodDurationAction,
  setAttestedPointsAction,
} from "@/app/actions/job-qa";
import { claimWorkFinished, attestWork } from "@/lib/work-completion";
import { TASK_POINTS_INTERACTION } from "@/lib/queries/stakes";

const MS_PER_HOUR = 3_600_000;

beforeEach(() => currentUserId.mockReset());

/** group + admin (admin membership) + worker (claimed the job) + job + task. */
async function scaffold(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const group = await createTestGroup(db, { name: "QA Group" });
  const admin = await createTestAgent(db, { name: "QA Admin", type: "person" });
  await createMembership(db, admin.id, group.id, "admin");
  const worker = await createTestAgent(db, { name: "QA Worker", type: "person" });
  await createMembership(db, worker.id, group.id);
  const job = await createTestResource(db, group.id, {
    name: "QA Job",
    type: "job",
    metadata: { status: "open", maxHours: 2 },
  });
  const task = await createTestResource(db, group.id, {
    name: "QA Task",
    type: "task",
    metadata: { jobId: job.id, points: 25 },
  });
  // Worker claims the job (assignee roster).
  await createTestLedgerEntry(db, worker.id, {
    verb: "join",
    objectId: job.id,
    objectType: "resource",
    isActive: true,
    metadata: { interactionType: "job-claim", targetId: job.id },
  });
  return { group, admin, worker, job, task };
}

/** Active attested points for a worker on a target. */
async function attestedPoints(
  db: { execute: (q: unknown) => Promise<unknown> },
  workerId: string,
  targetId: string,
): Promise<number | null> {
  const rows = (await db.execute(sql`
    SELECT (metadata->>'points')::int AS points FROM ledger
    WHERE subject_id = ${workerId}::uuid AND object_id = ${targetId}::uuid
      AND verb = 'earn' AND is_active = true
      AND metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
    LIMIT 1
  `)) as Array<{ points: number }>;
  return rows[0] ? Number(rows[0].points) : null;
}

describe("getJobQaReviewData — authority", () => {
  it("returns null for a viewer who can neither manage nor attest", () =>
    withTestTransaction(async (db) => {
      const { job } = await scaffold(db);
      const stranger = await createTestAgent(db, { name: "QA Stranger", type: "person" });
      currentUserId.mockResolvedValue(stranger.id);
      expect(await getJobQaReviewData(job.id)).toBeNull();
    }));

  it("returns per-assignee review data for a group admin", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      const data = await getJobQaReviewData(job.id);
      expect(data).not.toBeNull();
      expect(data!.canAttest).toBe(true);
      expect(data!.assignees).toHaveLength(1);
      expect(data!.assignees[0].assigneeId).toBe(worker.id);
    }));
});

describe("getJobQaReviewData — recorded time across both rails", () => {
  it("sums workperiod resources and legacy time_entry rows", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job, task } = await scaffold(db);
      // Current-rail completed workperiod: 1h.
      await createTestResource(db, worker.id, {
        name: "WP",
        type: "resource",
        metadata: {
          resourceKind: "workperiod",
          jobId: job.id,
          taskId: task.id,
          workerId: worker.id,
          startedAt: "2026-07-13T00:00:00.000Z",
          stoppedAt: "2026-07-13T01:00:00.000Z",
          durationMs: MS_PER_HOUR,
        },
      });
      // Legacy-rail entry: 0.5h.
      await createTestLedgerEntry(db, worker.id, {
        verb: "work",
        objectId: job.id,
        objectType: "resource",
        isActive: true,
        metadata: { interactionType: "time_entry", durationMs: MS_PER_HOUR / 2, stoppedAt: "2026-07-13T02:00:00.000Z" },
      });

      currentUserId.mockResolvedValue(admin.id);
      const data = await getJobQaReviewData(job.id);
      const assignee = data!.assignees[0];
      expect(assignee.workPeriods).toHaveLength(2);
      expect(assignee.trackedMs).toBe(MS_PER_HOUR + MS_PER_HOUR / 2);
      expect(assignee.workPeriods.some((p) => p.source === "legacy")).toBe(true);
    }));
});

describe("getJobQaReviewData — discrepancies", () => {
  it("flags a claim with 0 tracked time", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job, task, group } = await scaffold(db);
      await claimWorkFinished({
        workerId: worker.id,
        ref: { targetId: task.id, targetType: "task", ownerId: group.id, jobId: job.id, projectId: null },
      });
      currentUserId.mockResolvedValue(admin.id);
      const data = await getJobQaReviewData(job.id);
      expect(data!.assignees[0].discrepancies.some((d) => d.kind === "claimed_no_time")).toBe(true);
    }));

  it("flags proposed points that differ from attested", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job, task, group } = await scaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };
      await claimWorkFinished({ workerId: worker.id, ref, proposedPoints: 40 });
      await attestWork({ verifierId: admin.id, workerId: worker.id, ref, points: 25, outcome: "verified" });

      currentUserId.mockResolvedValue(admin.id);
      const data = await getJobQaReviewData(job.id);
      const t = data!.assignees[0].tasks.find((x) => x.taskId === task.id)!;
      expect(t.proposedPoints).toBe(40);
      expect(t.attestedPoints).toBe(25);
      expect(data!.assignees[0].discrepancies.some((d) => d.kind === "proposed_vs_attested")).toBe(true);
    }));
});

describe("editWorkPeriodDurationAction", () => {
  async function makePeriod(
    db: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
    ownerId: string,
    jobId: string,
    extra: Record<string, unknown> = {},
  ) {
    return createTestResource(db, ownerId, {
      name: "WP",
      type: "resource",
      metadata: {
        resourceKind: "workperiod",
        jobId,
        workerId: ownerId,
        startedAt: "2026-07-13T00:00:00.000Z",
        stoppedAt: "2026-07-13T01:00:00.000Z",
        durationMs: MS_PER_HOUR,
        ...extra,
      },
    });
  }

  it("lets an admin correct a duration and stamps the audit trail", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job } = await scaffold(db);
      const period = await makePeriod(db, worker.id, job.id);
      currentUserId.mockResolvedValue(admin.id);

      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: "workperiod", durationMs: 2 * MS_PER_HOUR });
      expect(result.success).toBe(true);

      const rows = (await db.execute(sql`SELECT metadata FROM resources WHERE id = ${period.id}::uuid`)) as Array<{ metadata: Record<string, unknown> }>;
      expect(Number(rows[0].metadata.durationMs)).toBe(2 * MS_PER_HOUR);
      expect(Number(rows[0].metadata.previousDurationMs)).toBe(MS_PER_HOUR);
      expect(rows[0].metadata.durationEditedBy).toBe(admin.id);
    }));

  it("lets a worker edit their OWN period", () =>
    withTestTransaction(async (db) => {
      const { worker, job } = await scaffold(db);
      const period = await makePeriod(db, worker.id, job.id);
      currentUserId.mockResolvedValue(worker.id);
      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: "workperiod", durationMs: 1800_000 });
      expect(result.success).toBe(true);
    }));

  it("denies a stranger", () =>
    withTestTransaction(async (db) => {
      const { worker, job } = await scaffold(db);
      const period = await makePeriod(db, worker.id, job.id);
      const stranger = await createTestAgent(db, { name: "S", type: "person" });
      currentUserId.mockResolvedValue(stranger.id);
      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: "workperiod", durationMs: 999 });
      expect(result.success).toBe(false);
    }));

  it("refuses to edit a running period", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job } = await scaffold(db);
      const period = await makePeriod(db, worker.id, job.id, { stoppedAt: null, durationMs: null });
      currentUserId.mockResolvedValue(admin.id);
      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: "workperiod", durationMs: MS_PER_HOUR });
      expect(result.success).toBe(false);
    }));

  it("rejects a negative duration", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job } = await scaffold(db);
      const period = await makePeriod(db, worker.id, job.id);
      currentUserId.mockResolvedValue(admin.id);
      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: "workperiod", durationMs: -1 });
      expect(result.success).toBe(false);
    }));
});

describe("setAttestedPointsAction", () => {
  it("attests points through the single writer (one active edge)", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job, task } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const result = await setAttestedPointsAction({ targetId: task.id, targetType: "task", workerId: worker.id, points: 30 });
      expect(result.success).toBe(true);
      expect(await attestedPoints(db, worker.id, task.id)).toBe(30);

      // Re-attest updates in place, no duplicate edge.
      await setAttestedPointsAction({ targetId: task.id, targetType: "task", workerId: worker.id, points: 15 });
      expect(await attestedPoints(db, worker.id, task.id)).toBe(15);
      const countRows = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM ledger
        WHERE subject_id = ${worker.id}::uuid AND object_id = ${task.id}::uuid
          AND verb = 'earn' AND is_active = true AND metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
      `)) as Array<{ n: number }>;
      expect(Number(countRows[0].n)).toBe(1);
    }));

  it("zero clears the award (deactivates the edge)", () =>
    withTestTransaction(async (db) => {
      const { admin, worker, job, task } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      await setAttestedPointsAction({ targetId: task.id, targetType: "task", workerId: worker.id, points: 20 });
      expect(await attestedPoints(db, worker.id, task.id)).toBe(20);
      await setAttestedPointsAction({ targetId: task.id, targetType: "task", workerId: worker.id, points: 0 });
      expect(await attestedPoints(db, worker.id, task.id)).toBeNull();
    }));

  it("denies a non-attester", () =>
    withTestTransaction(async (db) => {
      const { worker, task } = await scaffold(db);
      const stranger = await createTestAgent(db, { name: "S2", type: "person" });
      currentUserId.mockResolvedValue(stranger.id);
      const result = await setAttestedPointsAction({ targetId: task.id, targetType: "task", workerId: worker.id, points: 10 });
      expect(result.success).toBe(false);
    }));
});
