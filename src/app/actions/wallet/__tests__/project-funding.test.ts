/**
 * DB tests for `transferProjectBalanceAction` — the treasury ⇄ project-wallet
 * apportionment rail (2026-07-11): admin gate, both directions, balance
 * conservation, completed-project funding refusal, and cross-group project
 * rejection.
 *
 * Run with the db vitest config (pnpm test:db, Node ≥22).
 */
import { describe, it, expect, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource } from "@/test/fixtures";
import { mockAuthSession } from "@/test/auth-helpers";
import { eq } from "drizzle-orm";
import { wallets } from "@/db/schema";

// =============================================================================
// Mocks (mirrors treasury-funds.test.ts)
// =============================================================================

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// emitDomainEvent fires a fire-and-forget federation_events insert that would
// poison the shared test transaction; no-op it here.
vi.mock("@/lib/federation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/federation")>(
    "@/lib/federation",
  );
  return {
    ...actual,
    emitDomainEvent: vi.fn().mockResolvedValue({ id: "test-event" }),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    WALLET: { limit: 100, windowMs: 60_000 },
    WALLET_DEPOSIT: { limit: 50, windowMs: 60_000 },
  },
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { db } from "@/db";
import { getSettlementWalletForAgent, getProjectWalletForResource } from "@/lib/wallet";
import { transferProjectBalanceAction } from "../project-funding";

type TestDb = Parameters<Parameters<typeof withTestTransaction>[0]>[0];

/** Admin + funded group treasury + a project owned by the group. */
async function seedProjectFunding(testDb: TestDb) {
  const admin = await createTestAgent(testDb);
  const group = await createTestGroup(testDb, {
    metadata: { adminIds: [admin.id] },
  });
  const groupWallet = await getSettlementWalletForAgent(group.id);
  await db
    .update(wallets)
    .set({ balanceCents: 10_000 })
    .where(eq(wallets.id, groupWallet.id));
  const project = await createTestResource(testDb, group.id, {
    name: "Funding Test Project",
    type: "project",
    metadata: { resourceKind: "project", groupId: group.id },
  });
  return { admin, group, groupWallet, project };
}

describe("transferProjectBalanceAction", () => {
  it("rejects non-managers of the group treasury", () =>
    withTestTransaction(async (testDb) => {
      const { group, project } = await seedProjectFunding(testDb);
      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await transferProjectBalanceAction(group.id, project.id, 1_000, "to_project");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
    }));

  it("funds a project from the treasury and returns the residue, conserving balances", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, groupWallet, project } = await seedProjectFunding(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const funded = await transferProjectBalanceAction(group.id, project.id, 4_000, "to_project");
      expect(funded.success).toBe(true);
      expect(funded.transactionId).toBeTruthy();

      const projectWallet = await getProjectWalletForResource(project.id);
      expect(projectWallet).not.toBeNull();
      expect(projectWallet!.balanceCents).toBe(4_000);
      const [treasuryAfterFund] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, groupWallet.id));
      expect(treasuryAfterFund.balanceCents).toBe(6_000);

      const returned = await transferProjectBalanceAction(group.id, project.id, 1_500, "to_main");
      expect(returned.success).toBe(true);
      const [projectAfterReturn] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, projectWallet!.id));
      const [treasuryAfterReturn] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, groupWallet.id));
      expect(projectAfterReturn.balanceCents).toBe(2_500);
      expect(treasuryAfterReturn.balanceCents).toBe(7_500);
    }));

  it("refuses to fund a completed project (residue belongs to the sweep)", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedProjectFunding(testDb);
      const done = await createTestResource(testDb, group.id, {
        name: "Completed Project",
        type: "project",
        metadata: { resourceKind: "project", groupId: group.id, status: "completed" },
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await transferProjectBalanceAction(group.id, done.id, 1_000, "to_project");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/completed/i);
    }));

  it("rejects a project owned by a different group and non-project resources", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedProjectFunding(testDb);
      const otherGroup = await createTestGroup(testDb, {
        metadata: { adminIds: [admin.id] },
      });
      const foreignProject = await createTestResource(testDb, otherGroup.id, {
        name: "Foreign Project",
        type: "project",
        metadata: { resourceKind: "project" },
      });
      const document = await createTestResource(testDb, group.id, {
        name: "Not A Project",
        type: "document",
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const foreign = await transferProjectBalanceAction(group.id, foreignProject.id, 1_000, "to_project");
      expect(foreign.success).toBe(false);
      expect(foreign.error).toMatch(/does not belong/i);

      const notProject = await transferProjectBalanceAction(group.id, document.id, 1_000, "to_project");
      expect(notProject.success).toBe(false);
      expect(notProject.error).toMatch(/not found/i);
    }));
});
