/**
 * DB tests for project-completion settlement + subgroup treasury guarantees
 * (`@/app/actions/project-completion`): the completion sweep moves the
 * net-after-expenses into the OWNING group's treasury exactly once
 * (idempotent), authorization gates hold, and ensureSubgroupTreasuries
 * provisions the whole subtree idempotently.
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
  createTestWallet,
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

import { completeProjectAction, ensureSubgroupTreasuriesAction } from "@/app/actions/project-completion";

beforeEach(() => {
  currentUserId.mockReset();
});

async function walletBalance(
  db: { execute: (q: unknown) => Promise<unknown> },
  walletId: string,
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT balance_cents FROM wallets WHERE id = ${walletId}::uuid
  `)) as Array<{ balance_cents: number }>;
  return Number(rows[0]?.balance_cents ?? 0);
}

describe("completeProjectAction", () => {
  it("sweeps the net-after-expenses into the owning group's treasury, idempotently", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PC Subgroup" });
      const admin = await createTestAgent(db, { name: "PC Admin", type: "person" });
      await createMembership(db, admin.id, group.id, "admin");

      const project = await createTestResource(db, group.id, {
        name: "PC Project",
        type: "project",
        metadata: { status: "active" },
      });
      // Funded project treasury (resource-bound) — expenses already debited
      // in real flows, so the balance IS the net.
      const projectWallet = await createTestWallet(db, group.id, {
        type: "project",
        resourceId: project.id,
        balanceCents: 12_345,
      });
      // A recorded expense debit for the books (reported, not re-deducted).
      const payee = await createTestAgent(db, { name: "PC Vendor", type: "person" });
      const payeeWallet = await createTestWallet(db, payee.id, {});
      await db.execute(sql`
        INSERT INTO wallet_transactions (from_wallet_id, to_wallet_id, amount_cents, type, status, description)
        VALUES (${projectWallet.id}::uuid, ${payeeWallet.id}::uuid, 2000, 'project_expense', 'completed', 'PC expense')
      `);

      currentUserId.mockResolvedValue(admin.id);
      const result = await completeProjectAction(project.id);
      expect(result.success).toBe(true);
      expect(result.sweptCents).toBe(12_345);
      expect(result.expenseCents).toBe(2000);

      // Project wallet drained; group treasury credited.
      expect(await walletBalance(db, projectWallet.id)).toBe(0);
      const treasuryRows = (await db.execute(sql`
        SELECT balance_cents FROM wallets
        WHERE owner_id = ${group.id}::uuid AND type = 'group' AND resource_id IS NULL
      `)) as Array<{ balance_cents: number }>;
      expect(Number(treasuryRows[0]?.balance_cents ?? -1)).toBe(12_345);

      // Project marked completed with a recorded settlement.
      const projectRows = (await db.execute(sql`
        SELECT metadata->>'status' AS status,
               (metadata->'completionSettlement'->>'sweptCents')::int AS swept
        FROM resources WHERE id = ${project.id}::uuid
      `)) as Array<{ status: string; swept: number }>;
      expect(projectRows[0]?.status).toBe("completed");
      expect(Number(projectRows[0]?.swept)).toBe(12_345);

      // Re-running never moves money again.
      const again = await completeProjectAction(project.id);
      expect(again.success).toBe(true);
      expect(again.sweptCents).toBe(0);
      expect(await walletBalance(db, projectWallet.id)).toBe(0);
      expect(Number(((await db.execute(sql`
        SELECT balance_cents FROM wallets
        WHERE owner_id = ${group.id}::uuid AND type = 'group' AND resource_id IS NULL
      `)) as Array<{ balance_cents: number }>)[0]?.balance_cents)).toBe(12_345);
    }));

  it("completes cleanly when the project has no wallet (nothing to sweep)", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PC NoWallet Group" });
      const admin = await createTestAgent(db, { name: "PC Admin2", type: "person" });
      await createMembership(db, admin.id, group.id, "admin");
      const project = await createTestResource(db, group.id, {
        name: "PC Dry Project",
        type: "project",
        metadata: { status: "active" },
      });

      currentUserId.mockResolvedValue(admin.id);
      const result = await completeProjectAction(project.id);
      expect(result.success).toBe(true);
      expect(result.sweptCents).toBe(0);
    }));

  it("rejects callers without group authority or lead role", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PC Gate Group" });
      const outsider = await createTestAgent(db, { name: "PC Outsider", type: "person" });
      const project = await createTestResource(db, group.id, {
        name: "PC Gated Project",
        type: "project",
        metadata: { status: "active" },
      });

      currentUserId.mockResolvedValue(outsider.id);
      const result = await completeProjectAction(project.id);
      expect(result.success).toBe(false);
    }));

  it("allows the project LEAD to complete", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PC Lead Group" });
      const lead = await createTestAgent(db, { name: "PC Lead", type: "person" });
      const project = await createTestResource(db, group.id, {
        name: "PC Lead Project",
        type: "project",
        metadata: { status: "active", leadId: lead.id },
      });

      currentUserId.mockResolvedValue(lead.id);
      const result = await completeProjectAction(project.id);
      expect(result.success).toBe(true);
    }));
});

describe("ensureSubgroupTreasuriesAction", () => {
  it("provisions the whole subtree idempotently (admin-gated)", () =>
    withTestTransaction(async (db) => {
      const org = await createTestGroup(db, { name: "PC Org" });
      const circleA = await createTestGroup(db, { name: "PC Circle A", parentId: org.id });
      const circleB = await createTestGroup(db, { name: "PC Circle B", parentId: circleA.id });
      const admin = await createTestAgent(db, { name: "PC OrgAdmin", type: "person" });
      await createMembership(db, admin.id, org.id, "admin");

      currentUserId.mockResolvedValue(admin.id);
      const first = await ensureSubgroupTreasuriesAction(org.id);
      expect(first.success).toBe(true);
      expect(first.created).toHaveLength(3);

      for (const id of [org.id, circleA.id, circleB.id]) {
        const rows = (await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM wallets
          WHERE owner_id = ${id}::uuid AND type = 'group' AND resource_id IS NULL
        `)) as Array<{ n: number }>;
        expect(Number(rows[0]?.n)).toBe(1);
      }

      const second = await ensureSubgroupTreasuriesAction(org.id);
      expect(second.success).toBe(true);
      expect(second.created).toHaveLength(0);
      expect(second.existing).toBe(3);

      // Non-admins can't provision.
      const outsider = await createTestAgent(db, { name: "PC Nobody", type: "person" });
      currentUserId.mockResolvedValue(outsider.id);
      const gated = await ensureSubgroupTreasuriesAction(org.id);
      expect(gated.success).toBe(false);
    }));
});
