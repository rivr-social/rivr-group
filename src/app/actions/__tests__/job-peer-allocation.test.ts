/**
 * DB test for the job-level claim → attest morph data
 * (`@/app/actions/job-peer-allocation` `getJobShareData`): a job carrying an
 * ACTIVE job-level claim-complete surfaces its claimants (with self-ratings) +
 * completion state, so an attester's Points tab can morph into the
 * attest/approve affordance (directive #6).
 *
 * Run with `pnpm test:db`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource, createTestLedgerEntry } from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

import { getJobShareData } from "@/app/actions/job-peer-allocation";
import { claimWorkFinished } from "@/lib/work-completion";

beforeEach(() => currentUserId.mockReset());

async function scaffold(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const group = await createTestGroup(db, { name: "PA Group" });
  const worker = await createTestAgent(db, { name: "PA Worker", type: "person" });
  const job = await createTestResource(db, group.id, {
    name: "PA Job",
    type: "job",
    metadata: { status: "open", points: 30 },
  });
  // Active job-claim edge (the assignee roster peer allocation runs over).
  await createTestLedgerEntry(db, worker.id, {
    verb: "join",
    objectId: job.id,
    objectType: "resource",
    isActive: true,
    metadata: { interactionType: "job-claim", targetId: job.id },
  });
  return { group, worker, job };
}

describe("getJobShareData — job-level claim-complete", () => {
  it("surfaces active claimants with ratings + viewer/completion flags", () =>
    withTestTransaction(async (db) => {
      const { group, worker, job } = await scaffold(db);
      // Worker claims the WHOLE job finished with self-ratings.
      await claimWorkFinished({
        workerId: worker.id,
        ref: { targetId: job.id, targetType: "job", ownerId: group.id, jobId: job.id, projectId: null },
        skillfulness: 70,
        difficulty: 40,
      });

      currentUserId.mockResolvedValue(worker.id);
      const share = await getJobShareData(job.id);
      expect(share).not.toBeNull();
      expect(share!.jobCompleted).toBe(false);
      expect(share!.jobClaimants).toHaveLength(1);
      expect(share!.jobClaimants[0].id).toBe(worker.id);
      expect(share!.jobClaimants[0].skillfulness).toBe(70);
      expect(share!.jobClaimants[0].difficulty).toBe(40);
      expect(share!.viewerClaimedComplete).toBe(true);
    }));

  it("reflects a completed job and no claimants before any claim", () =>
    withTestTransaction(async (db) => {
      const { worker, job } = await scaffold(db);
      await db.execute(sql`
        UPDATE resources SET metadata = metadata || ${JSON.stringify({ status: "completed" })}::jsonb
        WHERE id = ${job.id}::uuid
      `);
      currentUserId.mockResolvedValue(worker.id);
      const share = await getJobShareData(job.id);
      expect(share!.jobCompleted).toBe(true);
      expect(share!.jobClaimants).toHaveLength(0);
      expect(share!.viewerClaimedComplete).toBe(false);
    }));
});
