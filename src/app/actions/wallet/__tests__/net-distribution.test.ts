/**
 * DB-backed tests for the gated Layer-2 project-net distribution RUN action.
 *
 * Money-safety contract under test:
 *  - Dry run (no `confirm`) returns the plan and moves NO money.
 *  - Confirmed run debits the project treasury by the distributed total and
 *    credits each recipient's settlement wallet EXACTLY (sum invariant), leaving
 *    the org-keep remainder in the treasury.
 *  - Insufficient treasury balance aborts the whole run (atomic).
 *  - Authz: only group-write callers may run distributions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestWallet,
  createMembership,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { wallets } from "@/db/schema";

// =============================================================================
// Mocks
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

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 100, windowMs: 60000 },
    WALLET: { limit: 50, windowMs: 60000 },
    SETTINGS: { limit: 20, windowMs: 60000 },
  },
}));

// Authz: default-grant write access; individual tests override to deny.
vi.mock("@/app/actions/resource-creation/helpers", () => ({
  hasGroupWriteAccess: vi.fn().mockResolvedValue(true),
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

// Import AFTER mocks
import { auth } from "@/auth";
import { hasGroupWriteAccess } from "@/app/actions/resource-creation/helpers";
import { runProjectNetDistributionAction } from "../net-distribution";

// Set an allocation tree (60% host class, 10% one individual) on the group meta.
async function seedAllocationTree(
  txDb: Awaited<ReturnType<typeof createTestGroup>> extends never ? never : any,
  groupId: string,
  rules: Array<{ targetType: string; targetId: string; bps: number }>,
) {
  const { agents } = await import("@/db/schema");
  await txDb
    .update(agents)
    .set({
      metadata: {
        netAllocation: { rules },
      },
    })
    .where(eq(agents.id, groupId));
}

// =============================================================================
// Tests
// =============================================================================

describe("runProjectNetDistributionAction (gated Layer-2 distribution)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasGroupWriteAccess).mockResolvedValue(true);
  });

  it("rejects an unauthenticated caller", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await runProjectNetDistributionAction({
        projectId: "11111111-1111-4111-8111-111111111111",
        groupId: "22222222-2222-4222-8222-222222222222",
        netCents: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("logged in");
    }));

  it("denies a caller without group-write access", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(hasGroupWriteAccess).mockResolvedValue(false);

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("permission");
    }));

  it("errors when the org has no net-allocation tree", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no net-allocation tree");
    }));

  it("DRY RUN returns a plan and moves NO money", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const recipient = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      const projectWallet = await createTestWallet(txDb, group.id, {
        type: "project",
        resourceId: project.id,
        balanceCents: 10000,
      });
      await seedAllocationTree(txDb, group.id, [
        { targetType: "individual", targetId: recipient.id, bps: 5000 },
      ]);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 10000,
        // no confirm → dry run
      });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(false);
      expect(result.plan?.distributedCents).toBe(5000);
      expect(result.plan?.orgKeepCents).toBe(5000);

      // Treasury untouched.
      const [after] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, projectWallet.id));
      expect(after.balanceCents).toBe(10000);
    }));

  it("CONFIRMED run debits treasury and credits the recipient exactly", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const recipient = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      const projectWallet = await createTestWallet(txDb, group.id, {
        type: "project",
        resourceId: project.id,
        balanceCents: 10000,
      });
      // Pre-create the recipient settlement wallet (avoids Stripe in tests).
      await createTestWallet(txDb, recipient.id, { type: "personal" });
      await seedAllocationTree(txDb, group.id, [
        { targetType: "individual", targetId: recipient.id, bps: 5000 },
      ]);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 10000,
        confirm: true,
      });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(true);
      expect(result.transactionIds?.length).toBe(1);

      // Treasury debited by the distributed total only (org keeps the remainder).
      const [treasuryAfter] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, projectWallet.id));
      expect(treasuryAfter.balanceCents).toBe(5000);

      // Recipient settlement wallet credited exactly the distributed cents.
      const [recipientWallet] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.ownerId, recipient.id));
      expect(recipientWallet.balanceCents).toBe(5000);
    }));

  it("distributes a class share across members with exact-sum rounding", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const m1 = await createTestAgent(txDb);
      const m2 = await createTestAgent(txDb);
      const m3 = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      const projectWallet = await createTestWallet(txDb, group.id, {
        type: "project",
        resourceId: project.id,
        balanceCents: 10000,
      });
      // Pre-create recipient settlement wallets so wallet creation does not
      // reach Stripe customer provisioning in the test environment.
      await createTestWallet(txDb, m1.id, { type: "personal" });
      await createTestWallet(txDb, m2.id, { type: "personal" });
      await createTestWallet(txDb, m3.id, { type: "personal" });
      // Three members in the 'host' class.
      await createMembership(txDb, m1.id, group.id, "host");
      await createMembership(txDb, m2.id, group.id, "host");
      await createMembership(txDb, m3.id, group.id, "host");
      // 100% of net to the host class.
      await seedAllocationTree(txDb, group.id, [
        { targetType: "class", targetId: "host", bps: 10000 },
      ]);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 100,
        confirm: true,
      });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(true);
      // 100 cents across 3 members: 34 + 33 + 33, exact sum, org keeps nothing.
      expect(result.plan?.distributedCents).toBe(100);
      expect(result.plan?.orgKeepCents).toBe(0);

      const credited = await Promise.all(
        [m1.id, m2.id, m3.id].map(async (id) => {
          const [w] = await txDb
            .select()
            .from(wallets)
            .where(eq(wallets.ownerId, id));
          return w?.balanceCents ?? 0;
        }),
      );
      expect(credited.reduce((s, c) => s + c, 0)).toBe(100);
      expect(credited.every((c) => c === 33 || c === 34)).toBe(true);

      // Treasury debited only by the distributed net (100 of 10000), since the
      // run distributes the requested net amount, not the entire balance.
      const [treasuryAfter] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, projectWallet.id));
      expect(treasuryAfter.balanceCents).toBe(9900);
    }));

  it("rejects a run that exceeds the treasury balance (atomic, no partial credit)", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const recipient = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const project = await createTestResource(txDb, group.id, {
        name: "Proj",
        type: "project",
      });
      const projectWallet = await createTestWallet(txDb, group.id, {
        type: "project",
        resourceId: project.id,
        balanceCents: 1000, // only $10 in treasury
      });
      // Pre-create the recipient settlement wallet (avoids Stripe in tests).
      await createTestWallet(txDb, recipient.id, { type: "personal" });
      await seedAllocationTree(txDb, group.id, [
        { targetType: "individual", targetId: recipient.id, bps: 10000 },
      ]);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: project.id,
        groupId: group.id,
        netCents: 5000, // ask to distribute $50 — more than the balance
        confirm: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Insufficient treasury balance");

      // Treasury untouched; recipient not credited.
      const [treasuryAfter] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, projectWallet.id));
      expect(treasuryAfter.balanceCents).toBe(1000);

      const recipientWallet = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.ownerId, recipient.id));
      // Either no wallet (never credited) or a zero-balance one.
      expect(recipientWallet[0]?.balanceCents ?? 0).toBe(0);
    }));

  it("rejects a non-project resource", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      const group = await createTestGroup(txDb);
      const notAProject = await createTestResource(txDb, group.id, {
        name: "An event",
        type: "event",
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await runProjectNetDistributionAction({
        projectId: notAProject.id,
        groupId: group.id,
        netCents: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("only be run against a project");
    }));
});
