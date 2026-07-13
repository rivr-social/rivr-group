/**
 * DB tests for the VOLUNTEER pay branch of `markJobDoneAction`
 * (`@/app/actions/job-completion`): marking a volunteer job done moves NO cash
 * and instead, per assignee, mints a Thanks voucher OWNED BY THE VOLUNTEER that
 * the GROUP claims/redeems — minting Thanks to the volunteer through the shared
 * `mintThanksTokensForVoucherRedemption` rail. The valuation reuses the voucher
 * formula (sqrt(skill × difficulty) × hours) and the whole settlement is
 * idempotent per assignee+job.
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

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/federation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/federation")>("@/lib/federation");
  return { ...actual, emitDomainEvent: vi.fn().mockResolvedValue({ id: "test-event" }) };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: { SOCIAL: { limit: 100, windowMs: 60_000 }, WALLET: { limit: 100, windowMs: 60_000 } },
}));

vi.mock("@/lib/federation/remote-write", () => ({
  federatedWrite: async (_params: unknown, local: () => Promise<unknown>) => ({
    success: true,
    data: await local(),
  }),
}));

const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

import { markJobDoneAction } from "@/app/actions/job-completion";

beforeEach(() => {
  currentUserId.mockReset();
});

/** Count active thanks tokens owned by an agent. */
async function thanksTokenCount(
  db: { execute: (q: unknown) => Promise<unknown> },
  ownerId: string,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM resources
    WHERE owner_id = ${ownerId}::uuid AND type = 'thanks_token' AND deleted_at IS NULL
  `)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Count vouchers owned by an agent. */
async function voucherCount(
  db: { execute: (q: unknown) => Promise<unknown> },
  ownerId: string,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM resources
    WHERE owner_id = ${ownerId}::uuid AND type = 'voucher'
  `)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Seeds a group + admin + one volunteer holding an active job-claim on a
 * volunteer-pay job, with a claim-complete edge carrying the given ratings.
 */
async function seedVolunteerJob(
  db: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
  opts: { skillfulness: number; difficulty: number; maxHours: number | null },
) {
  const group = await createTestGroup(db, { name: "Vol Group" });
  const admin = await createTestAgent(db, { name: "Vol Admin", type: "person" });
  await createMembership(db, admin.id, group.id, "admin");
  const volunteer = await createTestAgent(db, { name: "Vol Worker", type: "person" });

  const job = await createTestResource(db, group.id, {
    name: "Trail cleanup",
    type: "job",
    metadata: {
      payKind: "volunteer",
      maxHours: opts.maxHours,
      projectId: null,
    },
  });

  // Active job-claim edge (the assignee set).
  await createTestLedgerEntry(db, volunteer.id, {
    verb: "join",
    objectId: job.id,
    objectType: "resource",
    resourceId: job.id,
    metadata: { interactionType: "job-claim", targetId: job.id, targetType: "job" },
  });

  // Claim-complete edge carrying the voucher-style self-ratings.
  await createTestLedgerEntry(db, volunteer.id, {
    verb: "complete",
    objectId: job.id,
    objectType: "resource",
    resourceId: job.id,
    metadata: {
      interactionType: "work-completion-claim",
      targetId: job.id,
      targetType: "job",
      reviewStatus: "claimed",
      skillfulness: opts.skillfulness,
      difficulty: opts.difficulty,
    },
  });

  return { group, admin, volunteer, job };
}

describe("markJobDoneAction — volunteer pay", () => {
  it("mints a Thanks voucher for the volunteer and the group claims it (no cash), idempotently", () =>
    withTestTransaction(async (db) => {
      // skill 50 × difficulty 50 = 2500 → sqrt = 50, × 2h budget = 100 Thanks.
      const { group, volunteer, admin, job } = await seedVolunteerJob(db, {
        skillfulness: 50,
        difficulty: 50,
        maxHours: 2,
      });

      currentUserId.mockResolvedValue(admin.id);
      const result = await markJobDoneAction(job.id);

      expect(result.success).toBe(true);
      expect(result.payout?.kind).toBe("volunteer");
      expect(result.payout?.totalPaidCents).toBe(0);
      expect(result.payout?.entries).toHaveLength(1);
      const entry = result.payout!.entries[0];
      expect(entry.status).toBe("volunteer_voucher");
      expect(entry.thanksMinted).toBe(100);
      expect(entry.assigneeId).toBe(volunteer.id);

      // Exactly one voucher, owned by the volunteer, valued at 100 Thanks.
      expect(await voucherCount(db, volunteer.id)).toBe(1);
      const voucherRows = (await db.execute(sql`
        SELECT id, owner_id,
               metadata->>'voucherKind' AS kind,
               (metadata->'voucherValues'->>'thanksValue')::int AS thanks,
               metadata->>'status' AS status,
               metadata->>'redeemedBy' AS redeemed_by
        FROM resources WHERE owner_id = ${volunteer.id}::uuid AND type = 'voucher'
      `)) as Array<Record<string, unknown>>;
      expect(voucherRows[0].kind).toBe("volunteer");
      expect(Number(voucherRows[0].thanks)).toBe(100);
      expect(voucherRows[0].status).toBe("completed");
      expect(voucherRows[0].redeemed_by).toBe(group.id);

      // 100 Thanks tokens minted to the volunteer (the voucher owner).
      expect(await thanksTokenCount(db, volunteer.id)).toBe(100);

      // Redemption edge: the GROUP is the redeemer/claimant.
      const redemptionRows = (await db.execute(sql`
        SELECT subject_id, metadata->>'voucherOwnerId' AS owner
        FROM ledger
        WHERE verb = 'redeem'
          AND metadata->>'interactionType' = 'voucher-redemption'
          AND metadata->>'source' = 'volunteer-job'
      `)) as Array<{ subject_id: string; owner: string }>;
      expect(redemptionRows).toHaveLength(1);
      expect(redemptionRows[0].subject_id).toBe(group.id);
      expect(redemptionRows[0].owner).toBe(volunteer.id);

      // Idempotency anchor edge exists for the volunteer.
      const anchorRows = (await db.execute(sql`
        SELECT 1 FROM ledger
        WHERE verb = 'earn' AND subject_id = ${volunteer.id}::uuid AND is_active = true
          AND metadata->>'interactionType' = 'job-volunteer-voucher'
          AND metadata->>'jobId' = ${job.id}
      `)) as Array<unknown>;
      expect(anchorRows).toHaveLength(1);

      // Job flipped to completed with the voucher payout recorded.
      const jobRows = (await db.execute(sql`
        SELECT metadata->>'status' AS status, metadata->'payout'->>'status' AS payout_status
        FROM resources WHERE id = ${job.id}::uuid
      `)) as Array<{ status: string; payout_status: string }>;
      expect(jobRows[0].status).toBe("completed");
      expect(jobRows[0].payout_status).toBe("voucher");

      // Re-running mints nothing twice.
      const again = await markJobDoneAction(job.id);
      expect(again.success).toBe(true);
      expect(again.payout?.entries[0].status).toBe("already_paid");
      expect(await thanksTokenCount(db, volunteer.id)).toBe(100);
      expect(await voucherCount(db, volunteer.id)).toBe(1);
    }));

  it("falls back to the 1-hour floor and minimum ratings when nothing is recorded", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "Vol Floor Group" });
      const admin = await createTestAgent(db, { name: "Vol Floor Admin", type: "person" });
      await createMembership(db, admin.id, group.id, "admin");
      const volunteer = await createTestAgent(db, { name: "Vol Floor Worker", type: "person" });
      const job = await createTestResource(db, group.id, {
        name: "Ad-hoc help",
        type: "job",
        metadata: { payKind: "volunteer" },
      });
      // Assignee claimed the job but never ran a timer nor recorded ratings.
      await createTestLedgerEntry(db, volunteer.id, {
        verb: "join",
        objectId: job.id,
        objectType: "resource",
        resourceId: job.id,
        metadata: { interactionType: "job-claim", targetId: job.id, targetType: "job" },
      });

      currentUserId.mockResolvedValue(admin.id);
      const result = await markJobDoneAction(job.id);

      // sqrt(1 × 1) × 1h = 1 Thanks floor.
      expect(result.success).toBe(true);
      expect(result.payout?.entries[0].thanksMinted).toBe(1);
      expect(await thanksTokenCount(db, volunteer.id)).toBe(1);
    }));
});
