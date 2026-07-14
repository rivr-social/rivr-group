/**
 * DB test for directive #5: `markJobDoneAction` reads `payKind` FRESH from the
 * job row at completion time — a post-creation edit (e.g. fixed → volunteer)
 * takes effect immediately, so the volunteer voucher branch engages rather than
 * a stale cash-payout snapshot. (The client-side companion — clearing the
 * optimistic `jobOverride` on server refresh so the edited payKind renders — is
 * exercised in the UI, not here.)
 *
 * Run with `pnpm test:db`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource, createTestLedgerEntry, createMembership } from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/federation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/federation")>("@/lib/federation");
  return { ...actual, emitDomainEvent: vi.fn().mockResolvedValue({ id: "test-event" }) };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: { SOCIAL: { limit: 100, windowMs: 60_000 }, WALLET: { limit: 100, windowMs: 60_000 } },
}));
vi.mock("@/lib/federation/remote-write", () => ({
  federatedWrite: async (_p: unknown, local: () => Promise<unknown>) => ({ success: true, data: await local() }),
}));

const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

import { markJobDoneAction } from "@/app/actions/job-completion";

beforeEach(() => currentUserId.mockReset());

describe("markJobDoneAction — payKind edit takes effect immediately", () => {
  it("honors a post-creation fixed → volunteer edit (volunteer branch, not cash)", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PK Group" });
      const admin = await createTestAgent(db, { name: "PK Admin", type: "person" });
      await createMembership(db, admin.id, group.id, "admin");
      const worker = await createTestAgent(db, { name: "PK Worker", type: "person" });
      await createMembership(db, worker.id, group.id);

      // Created as a FIXED cash job.
      const job = await createTestResource(db, group.id, {
        name: "PK Job",
        type: "job",
        metadata: { status: "open", payKind: "fixed", payAmountCents: 5000 },
      });
      await createTestLedgerEntry(db, worker.id, {
        verb: "join",
        objectId: job.id,
        objectType: "resource",
        isActive: true,
        metadata: { interactionType: "job-claim", targetId: job.id },
      });

      // Admin edits it to VOLUNTEER after creation.
      await db.execute(sql`
        UPDATE resources SET metadata = metadata || ${JSON.stringify({ payKind: "volunteer" })}::jsonb
        WHERE id = ${job.id}::uuid
      `);

      currentUserId.mockResolvedValue(admin.id);
      const result = await markJobDoneAction(job.id);

      expect(result.success).toBe(true);
      // The FRESH payKind drives the branch: volunteer, never a cash payout.
      expect(result.payout?.kind).toBe("volunteer");
      const wora = result.payout?.entries.find((e) => e.assigneeId === worker.id);
      expect(wora?.status).toMatch(/^volunteer_/);

      // No cash payout edge was written (would exist if the stale 'fixed'
      // snapshot had been used).
      const cash = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM ledger
        WHERE object_id = ${job.id}::uuid AND verb = 'earn'
          AND metadata->>'interactionType' = 'job-cash-payout'
      `)) as Array<{ n: number }>;
      expect(Number(cash[0].n)).toBe(0);
    }));
});
