import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup } from "@/test/fixtures";
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

vi.mock("@/lib/stripe-connect", () => ({
  getConnectBalance: vi.fn().mockResolvedValue({ availableCents: 5000, pendingCents: 1000 }),
}));

vi.mock("@/lib/stripe-treasury", () => ({
  isTreasuryEnabled: vi.fn().mockReturnValue(true),
  isIssuingEnabled: vi.fn().mockReturnValue(true),
  createTreasuryFinancialAccount: vi.fn().mockResolvedValue({ id: "fa_test_1" }),
  getTreasuryFinancialAccountBalance: vi
    .fn()
    .mockResolvedValue({ cash: { usd: 12_345 }, inbound: {}, outbound: {} }),
  getExternalBankBalance: vi
    .fn()
    .mockResolvedValue({ current: { usd: 99_000 }, available: { usd: 88_000 }, asOf: 1_700_000_000 }),
  createIssuingCardholder: vi.fn().mockResolvedValue({ id: "ich_test_1" }),
  createTreasuryIssuingCard: vi.fn().mockResolvedValue({ id: "ic_test_1", last4: "4242" }),
  listIssuingCardsForCardholder: vi.fn().mockResolvedValue([
    { id: "ic_test_1", last4: "4242", status: "active", type: "virtual", spendingLimitCents: 50_000, spendingLimitInterval: "monthly" },
  ]),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { db } from "@/db";
import { getSettlementWalletForAgent } from "@/lib/wallet";
import {
  createTreasuryFinancialAccount,
  createTreasuryIssuingCard,
  createIssuingCardholder,
  isIssuingEnabled,
  isTreasuryEnabled,
} from "@/lib/stripe-treasury";
import {
  provisionSubgroupFinancialAccountAction,
  issueSubgroupCardAction,
  getGroupTreasuryBankingOverviewAction,
} from "../treasury-banking";

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(isTreasuryEnabled).mockReturnValue(true);
  vi.mocked(isIssuingEnabled).mockReturnValue(true);
  vi.mocked(createTreasuryFinancialAccount).mockClear();
  vi.mocked(createTreasuryIssuingCard).mockClear();
  vi.mocked(createIssuingCardholder).mockClear();
});

/** Create admin + group (admin in metadata.adminIds) + subgroup, and give the
 *  group's settlement wallet a connect account id. */
async function seedGroupBanking(testDb: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const admin = await createTestAgent(testDb);
  const group = await createTestGroup(testDb, {
    metadata: { adminIds: [admin.id] },
  });
  const subgroup = await createTestGroup(testDb, {
    name: "Tech Circle",
    parentId: group.id,
    metadata: {},
  });

  const groupWallet = await getSettlementWalletForAgent(group.id);
  await db
    .update(wallets)
    .set({ metadata: { stripeConnectAccountId: "acct_host_1" } })
    .where(eq(wallets.id, groupWallet.id));

  return { admin, group, subgroup };
}

// =============================================================================
// provisionSubgroupFinancialAccountAction
// =============================================================================

describe("provisionSubgroupFinancialAccountAction", () => {
  it("requires authentication", async () => {
    mockUnauthenticated(vi.mocked(auth));
    const result = await provisionSubgroupFinancialAccountAction("g1", "s1");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/logged in/i);
  });

  it("refuses when Treasury is not enabled", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isTreasuryEnabled).mockReturnValue(false);

      const result = await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not enabled/i);
    }));

  it("rejects a target that is not a subgroup of the group", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedGroupBanking(testDb);
      const stranger = await createTestGroup(testDb, { name: "Unrelated" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await provisionSubgroupFinancialAccountAction(group.id, stranger.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a subgroup/i);
    }));

  it("rejects a non-admin caller", () =>
    withTestTransaction(async (testDb) => {
      const { group, subgroup } = await seedGroupBanking(testDb);
      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
    }));

  it("provisions an FA on the parent's connect account and persists ids on the subgroup wallet", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      expect(result.success).toBe(true);
      expect(result.financialAccountId).toBe("fa_test_1");
      expect(vi.mocked(createTreasuryFinancialAccount)).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedAccountId: "acct_host_1",
          metadata: expect.objectContaining({ ownerId: subgroup.id, parentGroupId: group.id, treasuryKind: "subgroup" }),
        }),
      );

      const subWallet = await getSettlementWalletForAgent(subgroup.id);
      const [row] = await db.select({ metadata: wallets.metadata }).from(wallets).where(eq(wallets.id, subWallet.id));
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.stripeFinancialAccountId).toBe("fa_test_1");
      expect(meta.stripeHostConnectAccountId).toBe("acct_host_1");
    }));

  it("is idempotent — a second call returns the existing FA without a new Stripe call", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const first = await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      expect(first.success).toBe(true);
      const second = await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      expect(second.success).toBe(true);
      expect(second.financialAccountId).toBe("fa_test_1");
      expect(vi.mocked(createTreasuryFinancialAccount)).toHaveBeenCalledTimes(1);
    }));
});

// =============================================================================
// issueSubgroupCardAction
// =============================================================================

describe("issueSubgroupCardAction", () => {
  it("refuses when Issuing is not enabled", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isIssuingEnabled).mockReturnValue(false);

      const result = await issueSubgroupCardAction(group.id, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not enabled/i);
    }));

  it("rejects a non-positive spending limit", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await issueSubgroupCardAction(group.id, subgroup.id, { spendingLimitCents: -5 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/spending limit/i);
    }));

  it("requires the subgroup FA to exist first", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await issueSubgroupCardAction(group.id, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/provision/i);
    }));

  it("creates the cardholder once and issues a card tethered to the subgroup FA", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      const result = await issueSubgroupCardAction(group.id, subgroup.id, { spendingLimitCents: 25_000 });

      expect(result.success).toBe(true);
      expect(result.cardId).toBe("ic_test_1");
      expect(result.last4).toBe("4242");
      expect(vi.mocked(createIssuingCardholder)).toHaveBeenCalledWith(
        expect.objectContaining({ connectedAccountId: "acct_host_1", name: "Tech Circle" }),
      );
      expect(vi.mocked(createTreasuryIssuingCard)).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedAccountId: "acct_host_1",
          cardholderId: "ich_test_1",
          financialAccountId: "fa_test_1",
          spendingLimitCents: 25_000,
        }),
      );

      // Cardholder id persisted → second card reuses it.
      await issueSubgroupCardAction(group.id, subgroup.id);
      expect(vi.mocked(createIssuingCardholder)).toHaveBeenCalledTimes(1);
    }));
});

// =============================================================================
// getGroupTreasuryBankingOverviewAction
// =============================================================================

describe("getGroupTreasuryBankingOverviewAction", () => {
  it("returns group balances plus per-subgroup FA balances and cards", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedGroupBanking(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      await provisionSubgroupFinancialAccountAction(group.id, subgroup.id);
      await issueSubgroupCardAction(group.id, subgroup.id);

      const result = await getGroupTreasuryBankingOverviewAction(group.id);
      expect(result.success).toBe(true);
      const overview = result.overview!;
      expect(overview.groupConnectAccountId).toBe("acct_host_1");
      expect(overview.groupConnectBalance).toEqual({ availableCents: 5000, pendingCents: 1000 });

      const row = overview.subgroups.find((entry) => entry.subgroupId === subgroup.id);
      expect(row).toBeDefined();
      expect(row!.financialAccountId).toBe("fa_test_1");
      expect(row!.faCashCents).toBe(12_345);
      expect(row!.cards).toHaveLength(1);
      expect(row!.cards[0].last4).toBe("4242");
    }));

  it("degrades to an empty banking view when the group has no connect account", () =>
    withTestTransaction(async (testDb) => {
      const admin = await createTestAgent(testDb);
      const group = await createTestGroup(testDb, { metadata: { adminIds: [admin.id] } });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await getGroupTreasuryBankingOverviewAction(group.id);
      expect(result.success).toBe(true);
      expect(result.overview!.groupConnectAccountId).toBeNull();
      expect(result.overview!.groupConnectBalance).toBeNull();
    }));
});
