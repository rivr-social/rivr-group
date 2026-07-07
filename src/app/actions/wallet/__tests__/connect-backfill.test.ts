import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestSubscription } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { eq } from "drizzle-orm";
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

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

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

// The backfill imports the manage gate from resource-creation/helpers, which
// pulls in embedding/profile-sync side-effect modules at load time; stub them.
vi.mock("@/lib/ai", () => ({
  embedResource: vi.fn(),
  scheduleEmbedding: vi.fn(),
}));

vi.mock("@/lib/murmurations", () => ({
  syncMurmurationsProfilesForActor: vi.fn().mockResolvedValue(undefined),
}));

// Personal settlement wallets provision a Stripe customer on creation — keep
// the wallet path real (the ids must persist on real rows) but stub Stripe.
vi.mock("@/lib/billing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing")>(
    "@/lib/billing",
  );
  return {
    ...actual,
    getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_test_1"),
  };
});

vi.mock("@/lib/stripe-connect", () => ({
  createConnectAccount: vi.fn(async (agentId: string) => ({ id: `acct_express_${agentId}` })),
}));

vi.mock("@/lib/stripe-treasury", () => ({
  isCustomConnectEnabled: vi.fn().mockReturnValue(true),
  createCustomConnectAccount: vi.fn(),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { db } from "@/db";
import { getSettlementWalletForAgent } from "@/lib/wallet";
import { resetInstanceConfig } from "@/lib/federation/instance-config";
import { createConnectAccount } from "@/lib/stripe-connect";
import { createCustomConnectAccount, isCustomConnectEnabled } from "@/lib/stripe-treasury";
import { ensureConnectAccountForAgent } from "@/lib/connect-account";
import { backfillConnectAccountsAction } from "../connect-backfill";

const ORIGINAL_PRIMARY_AGENT_ID = process.env.PRIMARY_AGENT_ID;

/** Build the (partial) Stripe account object the Custom-account mock returns. */
function stripeAccount(id: string) {
  return { id } as Awaited<ReturnType<typeof createCustomConnectAccount>>;
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(isCustomConnectEnabled).mockReturnValue(true);
  vi.mocked(createCustomConnectAccount).mockReset();
  vi.mocked(createCustomConnectAccount).mockImplementation(async (input) =>
    stripeAccount(`acct_custom_${input.agentId}`),
  );
  vi.mocked(createConnectAccount).mockClear();
});

afterEach(() => {
  if (ORIGINAL_PRIMARY_AGENT_ID === undefined) {
    delete process.env.PRIMARY_AGENT_ID;
  } else {
    process.env.PRIMARY_AGENT_ID = ORIGINAL_PRIMARY_AGENT_ID;
  }
  resetInstanceConfig();
});

/** Agent ids the Custom-account mock was asked to create accounts for. */
function customAccountAgentIds(): string[] {
  return vi.mocked(createCustomConnectAccount).mock.calls.map(([input]) => input.agentId);
}

/** Read the persisted stripeConnectAccountId off an agent's settlement wallet. */
async function readConnectAccountId(agentId: string): Promise<string | undefined> {
  const wallet = await getSettlementWalletForAgent(agentId);
  const [row] = await db
    .select({ metadata: wallets.metadata })
    .from(wallets)
    .where(eq(wallets.id, wallet.id));
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return meta.stripeConnectAccountId as string | undefined;
}

/** Admin person (in the group's adminIds) + the instance's primary group. */
async function seedBackfillFixture(
  testDb: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
) {
  const admin = await createTestAgent(testDb);
  const group = await createTestGroup(testDb, { metadata: { adminIds: [admin.id] } });

  process.env.PRIMARY_AGENT_ID = group.id;
  resetInstanceConfig();

  return { admin, group };
}

// =============================================================================
// ensureConnectAccountForAgent (the shared provisioning core)
// =============================================================================

describe("ensureConnectAccountForAgent", () => {
  it("creates a Custom account and persists its id on the settlement wallet", () =>
    withTestTransaction(async (testDb) => {
      const member = await createTestAgent(testDb);

      const result = await ensureConnectAccountForAgent(member.id);

      expect(result.created).toBe(true);
      expect(result.connectAccountId).toBe(`acct_custom_${member.id}`);
      expect(vi.mocked(createCustomConnectAccount)).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: member.id,
          metadata: expect.objectContaining({ ownerId: member.id, walletType: "personal" }),
        }),
      );
      expect(await readConnectAccountId(member.id)).toBe(`acct_custom_${member.id}`);
    }));

  it("is idempotent — an existing wallet-metadata id short-circuits Stripe", () =>
    withTestTransaction(async (testDb) => {
      const member = await createTestAgent(testDb);
      const wallet = await getSettlementWalletForAgent(member.id);
      await db
        .update(wallets)
        .set({ metadata: { stripeConnectAccountId: "acct_preexisting_1" } })
        .where(eq(wallets.id, wallet.id));

      const result = await ensureConnectAccountForAgent(member.id);

      expect(result.created).toBe(false);
      expect(result.connectAccountId).toBe("acct_preexisting_1");
      expect(vi.mocked(createCustomConnectAccount)).not.toHaveBeenCalled();
      expect(await readConnectAccountId(member.id)).toBe("acct_preexisting_1");
    }));

  it("falls back to the Express creation path when Custom accounts are not enabled", () =>
    withTestTransaction(async (testDb) => {
      const member = await createTestAgent(testDb);
      vi.mocked(isCustomConnectEnabled).mockReturnValue(false);

      const result = await ensureConnectAccountForAgent(member.id);

      expect(result.created).toBe(true);
      expect(vi.mocked(createCustomConnectAccount)).not.toHaveBeenCalled();
      expect(vi.mocked(createConnectAccount)).toHaveBeenCalledWith(
        member.id,
        member.email,
        expect.objectContaining({ ownerId: member.id, walletType: "personal" }),
      );
      expect(await readConnectAccountId(member.id)).toBe(`acct_express_${member.id}`);
    }));

  it("rejects an unknown agent", async () => {
    await withTestTransaction(async () => {
      await expect(
        ensureConnectAccountForAgent("00000000-0000-0000-0000-00000000dead"),
      ).rejects.toThrow(/agent not found/i);
    });
  });
});

// =============================================================================
// backfillConnectAccountsAction — gating
// =============================================================================

describe("backfillConnectAccountsAction gating", () => {
  it("requires authentication", async () => {
    vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
    const result = await backfillConnectAccountsAction();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/logged in/i);
  });

  it("rejects a caller with no manage access on the primary group", () =>
    withTestTransaction(async (testDb) => {
      const { group } = await seedBackfillFixture(testDb);
      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await backfillConnectAccountsAction(group.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
      expect(vi.mocked(createCustomConnectAccount)).not.toHaveBeenCalled();
    }));

  it("allows a platform admin (metadata.siteRole) who is not a group admin", () =>
    withTestTransaction(async (testDb) => {
      const { group } = await seedBackfillFixture(testDb);
      const siteAdmin = await createTestAgent(testDb, {
        metadata: { siteRole: "admin" },
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(siteAdmin.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(true);
      expect(customAccountAgentIds()).toContain(group.id);
    }));

  it("fails cleanly when no primary group is configured and none is given", async () => {
    await withTestTransaction(async (testDb) => {
      const admin = await createTestAgent(testDb);
      delete process.env.PRIMARY_AGENT_ID;
      resetInstanceConfig();
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/primary group/i);
    });
  });
});

// =============================================================================
// backfillConnectAccountsAction — population (subscribing members + the group)
// =============================================================================

describe("backfillConnectAccountsAction population", () => {
  it("targets active/trialing subscribers plus the group agent, and persists ids on settlement wallets", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedBackfillFixture(testDb);
      const activeMember = await createTestAgent(testDb);
      await createTestSubscription(testDb, activeMember.id); // status: active
      const trialingMember = await createTestAgent(testDb);
      await createTestSubscription(testDb, trialingMember.id, { status: "trialing" });
      const lapsedMember = await createTestAgent(testDb);
      await createTestSubscription(testDb, lapsedMember.id, { status: "canceled" });
      const nonSubscriber = await createTestAgent(testDb);
      const federatedSubscriber = await createTestAgent(testDb, {
        metadata: { sourceNodeId: "node-remote-1" },
      });
      await createTestSubscription(testDb, federatedSubscriber.id);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();

      expect(result.success).toBe(true);
      expect(result.failed).toEqual([]);

      const provisioned = customAccountAgentIds();
      expect(provisioned).toContain(group.id);
      expect(provisioned).toContain(activeMember.id);
      expect(provisioned).toContain(trialingMember.id);
      expect(provisioned).not.toContain(lapsedMember.id);
      expect(provisioned).not.toContain(nonSubscriber.id);
      expect(provisioned).not.toContain(federatedSubscriber.id);
      // The admin holds no subscription — admin rights alone earn no account.
      expect(provisioned).not.toContain(admin.id);

      // Counts match the Stripe calls this run actually made.
      expect(result.created).toBe(provisioned.length);

      // Ids persisted exactly where every existing reader looks.
      expect(await readConnectAccountId(group.id)).toBe(`acct_custom_${group.id}`);
      expect(await readConnectAccountId(activeMember.id)).toBe(
        `acct_custom_${activeMember.id}`,
      );
      expect(await readConnectAccountId(trialingMember.id)).toBe(
        `acct_custom_${trialingMember.id}`,
      );
    }));

  it("deduplicates a subscriber with multiple active subscription rows", () =>
    withTestTransaction(async (testDb) => {
      const { admin } = await seedBackfillFixture(testDb);
      const member = await createTestAgent(testDb);
      await createTestSubscription(testDb, member.id, { membershipTier: "host" });
      await createTestSubscription(testDb, member.id, { membershipTier: "seller" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();

      expect(result.success).toBe(true);
      const calls = customAccountAgentIds().filter((id) => id === member.id);
      expect(calls).toHaveLength(1);
    }));

  it("an explicit groupId overrides which group agent joins the batch", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedBackfillFixture(testDb);
      const subgroup = await createTestGroup(testDb, { parentId: group.id });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction(subgroup.id);

      expect(result.success).toBe(true);
      const provisioned = customAccountAgentIds();
      expect(provisioned).toContain(subgroup.id);
      expect(provisioned).not.toContain(group.id);
    }));
});

// =============================================================================
// backfillConnectAccountsAction — idempotency / resumability
// =============================================================================

describe("backfillConnectAccountsAction idempotency", () => {
  it("counts an agent with an existing account as existing, without a Stripe call", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedBackfillFixture(testDb);
      const groupWallet = await getSettlementWalletForAgent(group.id);
      await db
        .update(wallets)
        .set({ metadata: { stripeConnectAccountId: "acct_preexisting_1" } })
        .where(eq(wallets.id, groupWallet.id));
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();

      expect(result.success).toBe(true);
      expect(result.existing).toBeGreaterThanOrEqual(1);
      expect(customAccountAgentIds()).not.toContain(group.id);
      // The pre-existing id is preserved, not replaced.
      expect(await readConnectAccountId(group.id)).toBe("acct_preexisting_1");
    }));

  it("is re-run safe: the second run creates nothing and reports everything as existing", () =>
    withTestTransaction(async (testDb) => {
      const { admin } = await seedBackfillFixture(testDb);
      const member = await createTestAgent(testDb);
      await createTestSubscription(testDb, member.id);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const first = await backfillConnectAccountsAction();
      expect(first.success).toBe(true);
      const stripeCallsAfterFirstRun = vi.mocked(createCustomConnectAccount).mock.calls.length;
      expect(first.created).toBe(stripeCallsAfterFirstRun);

      const second = await backfillConnectAccountsAction();
      expect(second.success).toBe(true);
      expect(second.created).toBe(0);
      expect(second.existing).toBe((first.created ?? 0) + (first.existing ?? 0));
      expect(second.failed).toEqual([]);
      expect(vi.mocked(createCustomConnectAccount).mock.calls.length).toBe(
        stripeCallsAfterFirstRun,
      );
    }));
});

// =============================================================================
// backfillConnectAccountsAction — failure isolation
// =============================================================================

describe("backfillConnectAccountsAction failure isolation", () => {
  it("one agent failing does not abort the batch — it is reported in failed and retried on re-run", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedBackfillFixture(testDb);
      const goodMember = await createTestAgent(testDb);
      await createTestSubscription(testDb, goodMember.id);
      const badMember = await createTestAgent(testDb);
      await createTestSubscription(testDb, badMember.id);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(createCustomConnectAccount).mockImplementation(async (input) => {
        if (input.agentId === badMember.id) {
          throw new Error("Stripe rejected this account");
        }
        return stripeAccount(`acct_custom_${input.agentId}`);
      });

      const result = await backfillConnectAccountsAction();

      expect(result.success).toBe(true);
      expect(result.failed).toEqual([
        { agentId: badMember.id, error: "Stripe rejected this account" },
      ]);
      // The rest of the batch still ran and persisted.
      expect(result.created).toBeGreaterThanOrEqual(2);
      expect(await readConnectAccountId(group.id)).toBe(`acct_custom_${group.id}`);
      expect(await readConnectAccountId(goodMember.id)).toBe(`acct_custom_${goodMember.id}`);
      expect(await readConnectAccountId(badMember.id)).toBeUndefined();

      // Re-run picks the failed agent back up once Stripe recovers.
      vi.mocked(createCustomConnectAccount).mockImplementation(async (input) =>
        stripeAccount(`acct_custom_${input.agentId}`),
      );
      const retry = await backfillConnectAccountsAction();
      expect(retry.success).toBe(true);
      expect(retry.created).toBe(1);
      expect(retry.failed).toEqual([]);
      expect(await readConnectAccountId(badMember.id)).toBe(`acct_custom_${badMember.id}`);
    }));
});
