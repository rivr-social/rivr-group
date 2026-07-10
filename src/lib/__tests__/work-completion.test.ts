/**
 * DB tests for the work-completion claim → attest rail
 * (`@/lib/work-completion`): finish-claims, attestation-time point awards
 * (single active edge — no duplicate awards), rejection/retraction
 * deactivation, running-workperiod linkage, and verifier authority
 * resolution (lead / QA / group-agent QA).
 *
 * Run with `pnpm test:db` (requires the drizzle-kit-pushed test database).
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource, createMembership } from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import {
  claimWorkFinished,
  attestWork,
  retractWorkClaim,
  getLatestWorkClaim,
  resolveProjectAuthority,
  canAttestWork,
  WORK_COMPLETION_CLAIM_INTERACTION,
} from "@/lib/work-completion";
import { TASK_POINTS_INTERACTION } from "@/lib/queries/stakes";

/** Counts ledger edges of an interaction type on a target, by activity. */
async function countEdges(
  db: { execute: (q: unknown) => Promise<unknown> },
  targetId: string,
  interaction: string,
  activeOnly: boolean,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM ledger
    WHERE object_id = ${targetId}::uuid
      AND metadata->>'interactionType' = ${interaction}
      ${activeOnly ? sql`AND is_active = true` : sql``}
  `)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Builds group → job → task scaffolding with points on the task. */
async function buildScaffold(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const group = await createTestGroup(db, { name: "WC Test Group" });
  const worker = await createTestAgent(db, { name: "WC Worker", type: "person" });
  await createMembership(db, worker.id, group.id);
  const job = await createTestResource(db, group.id, {
    name: "WC Job",
    type: "job",
    metadata: { status: "open" },
  });
  const task = await createTestResource(db, group.id, {
    name: "WC Task",
    type: "task",
    metadata: { jobId: job.id, points: 25 },
  });
  return { group, worker, job, task };
}

describe("claimWorkFinished", () => {
  it("writes a claimed edge, idempotently", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref });
      await claimWorkFinished({ workerId: worker.id, ref }); // duplicate no-ops

      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, true)).toBe(1);
      const claim = await getLatestWorkClaim(task.id);
      expect(claim?.workerId).toBe(worker.id);
      expect(claim?.reviewStatus).toBe("claimed");
      // No points move at claim time.
      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(0);
    }));

  it("links the worker's RUNNING workperiod on the job", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const period = await createTestResource(db, worker.id, {
        name: "WC Period",
        type: "resource",
        metadata: { resourceKind: "workperiod", jobId: job.id, workerId: worker.id, startedAt: "2026-07-10T00:00:00.000Z" },
      });

      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };
      const { workPeriodId } = await claimWorkFinished({ workerId: worker.id, ref });

      expect(workPeriodId).toBe(period.id);
      const rows = (await db.execute(sql`
        SELECT metadata->'tasksCompletedDuringPeriod' AS linked FROM resources WHERE id = ${period.id}::uuid
      `)) as Array<{ linked: unknown }>;
      expect(rows[0]?.linked).toEqual([task.id]);
    }));

  it("records the claimant's proposed points on the claim edge", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref, proposedPoints: 40 });

      const claim = await getLatestWorkClaim(task.id);
      expect(claim?.proposedPoints).toBe(40);
    }));
});

describe("attestWork", () => {
  it("verification awards points exactly once, re-attest updates in place", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const verifier = await createTestAgent(db, { name: "WC Verifier", type: "person" });
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref });
      const first = await attestWork({ verifierId: verifier.id, workerId: worker.id, ref, points: 25, outcome: "verified" });
      expect(first.awardedPoints).toBe(25);

      // Re-attestation (e.g. corrected points) must not duplicate the edge.
      const second = await attestWork({ verifierId: verifier.id, workerId: worker.id, ref, points: 30, outcome: "verified" });
      expect(second.awardedPoints).toBe(30);

      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(1);
      const rows = (await db.execute(sql`
        SELECT metadata->>'points' AS points FROM ledger
        WHERE object_id = ${task.id}::uuid AND metadata->>'interactionType' = ${TASK_POINTS_INTERACTION} AND is_active = true
      `)) as Array<{ points: string }>;
      expect(Number(rows[0]?.points)).toBe(30);

      const claim = await getLatestWorkClaim(task.id);
      expect(claim?.reviewStatus).toBe("verified");
    }));

  it("creates the claim implicitly for a verifier's one-click completion", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      // No prior claim — verifier completes their own work in one click.
      const result = await attestWork({ verifierId: worker.id, workerId: worker.id, ref, points: 25, outcome: "verified" });
      expect(result.awardedPoints).toBe(25);
      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, true)).toBe(1);
      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(1);
    }));

  it("rejection deactivates the claim and any points", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const verifier = await createTestAgent(db, { name: "WC Verifier", type: "person" });
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref });
      await attestWork({ verifierId: verifier.id, workerId: worker.id, ref, points: 25, outcome: "verified" });
      await attestWork({ verifierId: verifier.id, workerId: worker.id, ref, points: 0, outcome: "rejected" });

      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(0);
      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, true)).toBe(0);
      const claim = await getLatestWorkClaim(task.id);
      expect(claim?.reviewStatus).toBe("rejected");
    }));

  it("awards nothing for non-positive points", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref });
      const result = await attestWork({ verifierId: worker.id, workerId: worker.id, ref, points: 0, outcome: "verified" });
      expect(result.awardedPoints).toBe(0);
      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(0);
    }));
});

describe("retractWorkClaim", () => {
  it("deactivates the claim AND awarded points (reopen)", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job, task } = await buildScaffold(db);
      const ref = { targetId: task.id, targetType: "task" as const, ownerId: group.id, jobId: job.id, projectId: null };

      await claimWorkFinished({ workerId: worker.id, ref });
      await attestWork({ verifierId: worker.id, workerId: worker.id, ref, points: 25, outcome: "verified" });
      await retractWorkClaim(worker.id, task.id);

      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, true)).toBe(0);
      expect(await countEdges(db, task.id, TASK_POINTS_INTERACTION, true)).toBe(0);

      // Re-claim after retraction reactivates rather than duplicating.
      await claimWorkFinished({ workerId: worker.id, ref });
      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, true)).toBe(1);
      expect(await countEdges(db, task.id, WORK_COMPLETION_CLAIM_INTERACTION, false)).toBe(1);
    }));
});

describe("resolveProjectAuthority + canAttestWork", () => {
  it("resolves lead/QA from a resource-shaped project, QA defaulting to lead", () =>
    withTestTransaction(async (db) => {
      const { group, job } = await buildScaffold(db);
      const lead = await createTestAgent(db, { name: "WC Lead", type: "person" });
      const project = await createTestResource(db, group.id, {
        name: "WC Project",
        type: "project",
        metadata: { leadId: lead.id },
      });
      await db.execute(sql`
        UPDATE resources SET metadata = metadata || ${JSON.stringify({ projectId: project.id })}::jsonb
        WHERE id = ${job.id}::uuid
      `);

      const authority = await resolveProjectAuthority({ targetType: "task", jobId: job.id, projectId: null });
      expect(authority.projectId).toBe(project.id);
      expect(authority.leadId).toBe(lead.id);
      expect(authority.qaId).toBe(lead.id); // default: lead is QA

      expect(await canAttestWork(lead.id, group.id, authority)).toBe(true);
      const stranger = await createTestAgent(db, { name: "WC Stranger", type: "person" });
      expect(await canAttestWork(stranger.id, group.id, authority)).toBe(false);
    }));

  it("group-agent QA authorizes that group's admins", () =>
    withTestTransaction(async (db) => {
      const { group } = await buildScaffold(db);
      const qaGroup = await createTestGroup(db, { name: "WC QA Group" });
      const qaAdmin = await createTestAgent(db, { name: "WC QA Admin", type: "person" });
      // Admin membership on the QA group (role recorded on the edge).
      await createMembership(db, qaAdmin.id, qaGroup.id, "admin");

      const authority = { projectId: null, leadId: null, qaId: qaGroup.id };
      expect(await canAttestWork(qaAdmin.id, group.id, authority)).toBe(true);

      const plain = await createTestAgent(db, { name: "WC Plain", type: "person" });
      expect(await canAttestWork(plain.id, group.id, authority)).toBe(false);
    }));
});
