import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { and, eq, isNull } from "drizzle-orm";
import { resources, wallets } from "@/db/schema";

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

// The transfer action is rate-limited; keep the limiter permissive in tests
// (the real module would otherwise try Redis / in-memory windows).
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    WALLET: { limit: 100, windowMs: 60_000 },
    WALLET_DEPOSIT: { limit: 50, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/stripe-treasury", () => ({
  isTreasuryEnabled: vi.fn().mockReturnValue(true),
  isIssuingEnabled: vi.fn().mockReturnValue(true),
  createTreasuryFinancialAccount: vi.fn().mockResolvedValue({ id: "fa_fund_1" }),
  getTreasuryFinancialAccountBalance: vi
    .fn()
    .mockResolvedValue({ cash: { usd: 7_500 }, inbound: {}, outbound: {} }),
  getExternalBankBalance: vi.fn().mockResolvedValue(null),
  createIssuingCardholder: vi.fn().mockResolvedValue({ id: "ich_fund_1" }),
  createTreasuryIssuingCard: vi.fn().mockResolvedValue({ id: "ic_fund_1", last4: "1234" }),
  listIssuingCardsForCardholder: vi.fn().mockResolvedValue([
    { id: "ic_fund_1", last4: "1234", status: "active", type: "virtual", spendingLimitCents: 50_000, spendingLimitInterval: "monthly" },
  ]),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { db } from "@/db";
import { getSettlementWalletForAgent } from "@/lib/wallet";
import {
  createIssuingCardholder,
  createTreasuryFinancialAccount,
  createTreasuryIssuingCard,
  isIssuingEnabled,
  isTreasuryEnabled,
} from "@/lib/stripe-treasury";
import {
  assignSubgroupToFundAction,
  createFundAction,
  getGroupTreasuryFundsOverviewAction,
  issueFundCardAction,
  provisionFundFinancialAccountAction,
  transferFundBalanceAction,
  unassignSubgroupFromFundAction,
  updateFundAction,
} from "../treasury-funds";

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(isTreasuryEnabled).mockReturnValue(true);
  vi.mocked(isIssuingEnabled).mockReturnValue(true);
  vi.mocked(createTreasuryFinancialAccount).mockClear();
  vi.mocked(createTreasuryIssuingCard).mockClear();
  vi.mocked(createIssuingCardholder).mockClear();
});

/** Create admin + group (admin in metadata.adminIds) + subgroup, and give the
 *  group's settlement wallet a funded balance + connect account id. */
async function seedTreasuryFunds(testDb: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const admin = await createTestAgent(testDb);
  const group = await createTestGroup(testDb, {
    metadata: { adminIds: [admin.id] },
  });
  const subgroup = await createTestGroup(testDb, {
    name: "Garden Circle",
    parentId: group.id,
    metadata: {},
  });

  const groupWallet = await getSettlementWalletForAgent(group.id);
  await db
    .update(wallets)
    .set({
      balanceCents: 20_000,
      metadata: { stripeConnectAccountId: "acct_host_fund" },
    })
    .where(eq(wallets.id, groupWallet.id));

  return { admin, group, subgroup, groupWalletId: groupWallet.id };
}

/** Reads the wallet bound to a fund resource (resource-keyed, like projects). */
async function getFundWalletRow(fundId: string) {
  const [row] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.resourceId, fundId))
    .limit(1);
  return row ?? null;
}

async function getFundResourceRow(fundId: string) {
  const [row] = await db
    .select()
    .from(resources)
    .where(and(eq(resources.id, fundId), isNull(resources.deletedAt)))
    .limit(1);
  return row ?? null;
}

// =============================================================================
// createFundAction
// =============================================================================

describe("createFundAction", () => {
  it("requires authentication", async () => {
    mockUnauthenticated(vi.mocked(auth));
    const result = await createFundAction("00000000-0000-4000-8000-000000000001", { name: "Ops" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/logged in/i);
  });

  it("rejects a non-admin caller", () =>
    withTestTransaction(async (testDb) => {
      const { group } = await seedTreasuryFunds(testDb);
      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await createFundAction(group.id, { name: "Ops Fund" });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
    }));

  it("rejects an empty fund name", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await createFundAction(group.id, { name: "   " });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name is required/i);
    }));

  it("creates the fund resource with a bound fund wallet", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await createFundAction(group.id, {
        name: "Land Fund",
        description: "Buying the back lot",
      });
      expect(result.success).toBe(true);
      expect(result.fundId).toBeDefined();

      const fund = await getFundResourceRow(result.fundId!);
      expect(fund).not.toBeNull();
      expect(fund!.name).toBe("Land Fund");
      expect(fund!.ownerId).toBe(group.id);
      const metadata = fund!.metadata as Record<string, unknown>;
      expect(metadata.resourceKind).toBe("fund");
      expect(metadata.groupId).toBe(group.id);
      expect(metadata.assignedSubgroupIds).toEqual([]);
      expect(metadata.archived).toBe(false);

      const wallet = await getFundWalletRow(result.fundId!);
      expect(wallet).not.toBeNull();
      expect(wallet!.type).toBe("project");
      expect(wallet!.ownerId).toBe(group.id);
      expect(wallet!.balanceCents).toBe(0);
      expect((wallet!.metadata as Record<string, unknown>).walletKind).toBe("fund");
    }));

  it("rejects a duplicate name among non-archived funds", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const first = await createFundAction(group.id, { name: "Ops Fund" });
      expect(first.success).toBe(true);

      const duplicate = await createFundAction(group.id, { name: "  ops fund " });
      expect(duplicate.success).toBe(false);
      expect(duplicate.error).toMatch(/already exists/i);
    }));

  it("allows reusing the name of an ARCHIVED fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const first = await createFundAction(group.id, { name: "Ops Fund" });
      expect(first.success).toBe(true);
      const archived = await updateFundAction(group.id, first.fundId!, { archived: true });
      expect(archived.success).toBe(true);

      const second = await createFundAction(group.id, { name: "Ops Fund" });
      expect(second.success).toBe(true);
    }));
});

// =============================================================================
// updateFundAction
// =============================================================================

describe("updateFundAction", () => {
  it("renames a fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops" });
      const result = await updateFundAction(group.id, created.fundId!, { name: "Operations Fund" });
      expect(result.success).toBe(true);

      const fund = await getFundResourceRow(created.fundId!);
      expect(fund!.name).toBe("Operations Fund");
    }));

  it("rejects renaming to another live fund's name", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      await createFundAction(group.id, { name: "Ops Fund" });
      const other = await createFundAction(group.id, { name: "Land Fund" });

      const result = await updateFundAction(group.id, other.fundId!, { name: "Ops Fund" });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already exists/i);
    }));

  it("refuses to archive a fund holding a balance", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const moved = await transferFundBalanceAction(group.id, created.fundId!, 5_000, "to_fund");
      expect(moved.success).toBe(true);

      const result = await updateFundAction(group.id, created.fundId!, { archived: true });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/balance/i);
    }));

  it("archiving clears subgroup assignments; restore keeps them cleared", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const assigned = await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      expect(assigned.success).toBe(true);

      const archived = await updateFundAction(group.id, created.fundId!, { archived: true });
      expect(archived.success).toBe(true);
      let fund = await getFundResourceRow(created.fundId!);
      expect((fund!.metadata as Record<string, unknown>).archived).toBe(true);
      expect((fund!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([]);

      const restored = await updateFundAction(group.id, created.fundId!, { archived: false });
      expect(restored.success).toBe(true);
      fund = await getFundResourceRow(created.fundId!);
      expect((fund!.metadata as Record<string, unknown>).archived).toBe(false);
      expect((fund!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([]);
    }));

  it("rejects an update with no fields", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await updateFundAction(group.id, created.fundId!, {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/nothing to update/i);
    }));
});

// =============================================================================
// assignSubgroupToFundAction / unassignSubgroupFromFundAction
// =============================================================================

describe("assignSubgroupToFundAction", () => {
  it("rejects a target that is not a subgroup of the group", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      const stranger = await createTestGroup(testDb, { name: "Unrelated" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await assignSubgroupToFundAction(group.id, created.fundId!, stranger.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a subgroup/i);
    }));

  it("rejects a non-admin caller", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      const created = await createFundAction(group.id, { name: "Ops Fund" });

      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));
      const result = await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
    }));

  it("enforces the single-fund invariant — moving a subgroup removes it from its previous fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const fundA = await createFundAction(group.id, { name: "Ops Fund" });
      const fundB = await createFundAction(group.id, { name: "Land Fund" });

      const first = await assignSubgroupToFundAction(group.id, fundA.fundId!, subgroup.id);
      expect(first.success).toBe(true);
      const moved = await assignSubgroupToFundAction(group.id, fundB.fundId!, subgroup.id);
      expect(moved.success).toBe(true);

      const rowA = await getFundResourceRow(fundA.fundId!);
      const rowB = await getFundResourceRow(fundB.fundId!);
      expect((rowA!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([]);
      expect((rowB!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([subgroup.id]);
    }));

  it("is idempotent for a subgroup already in the fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      const again = await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      expect(again.success).toBe(true);

      const fund = await getFundResourceRow(created.fundId!);
      expect((fund!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([subgroup.id]);
    }));

  it("refuses assignment to an archived fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await updateFundAction(group.id, created.fundId!, { archived: true });

      const result = await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/archived/i);
    }));
});

describe("unassignSubgroupFromFundAction", () => {
  it("removes an assigned subgroup", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);

      const result = await unassignSubgroupFromFundAction(group.id, created.fundId!, subgroup.id);
      expect(result.success).toBe(true);
      const fund = await getFundResourceRow(created.fundId!);
      expect((fund!.metadata as Record<string, unknown>).assignedSubgroupIds).toEqual([]);
    }));

  it("errors when the subgroup is not assigned to that fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await unassignSubgroupFromFundAction(group.id, created.fundId!, subgroup.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not assigned/i);
    }));
});

// =============================================================================
// transferFundBalanceAction
// =============================================================================

describe("transferFundBalanceAction", () => {
  it("moves money from the main treasury into the fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, groupWalletId } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await transferFundBalanceAction(group.id, created.fundId!, 5_000, "to_fund");
      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();

      const fundWallet = await getFundWalletRow(created.fundId!);
      expect(fundWallet!.balanceCents).toBe(5_000);
      const [groupWallet] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, groupWalletId));
      expect(groupWallet.balanceCents).toBe(15_000);
    }));

  it("moves money from the fund back to the main treasury", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, groupWalletId } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await transferFundBalanceAction(group.id, created.fundId!, 5_000, "to_fund");
      const result = await transferFundBalanceAction(group.id, created.fundId!, 2_000, "to_main");
      expect(result.success).toBe(true);

      const fundWallet = await getFundWalletRow(created.fundId!);
      expect(fundWallet!.balanceCents).toBe(3_000);
      const [groupWallet] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, groupWalletId));
      expect(groupWallet.balanceCents).toBe(17_000);
    }));

  it("rejects a transfer exceeding the source balance", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      // Fund is empty — pulling from it must fail with the insufficient-balance error.
      const result = await transferFundBalanceAction(group.id, created.fundId!, 1_000, "to_main");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/insufficient/i);
    }));

  it("rejects non-positive and non-integer amounts", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const negative = await transferFundBalanceAction(group.id, created.fundId!, -100, "to_fund");
      expect(negative.success).toBe(false);
      expect(negative.error).toMatch(/positive integer/i);

      const fractional = await transferFundBalanceAction(group.id, created.fundId!, 10.5, "to_fund");
      expect(fractional.success).toBe(false);
      expect(fractional.error).toMatch(/positive integer/i);
    }));

  it("rejects an invalid direction", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await transferFundBalanceAction(
        group.id,
        created.fundId!,
        1_000,
        "sideways" as never,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/direction/i);
    }));

  it("refuses to move money INTO an archived fund", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await updateFundAction(group.id, created.fundId!, { archived: true });

      const result = await transferFundBalanceAction(group.id, created.fundId!, 1_000, "to_fund");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/archived/i);
    }));
});

// =============================================================================
// provisionFundFinancialAccountAction / issueFundCardAction
// =============================================================================

describe("provisionFundFinancialAccountAction", () => {
  it("refuses when Treasury is not enabled", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      const created = await createFundAction(group.id, { name: "Ops Fund" });
      vi.mocked(isTreasuryEnabled).mockReturnValue(false);

      const result = await provisionFundFinancialAccountAction(group.id, created.fundId!);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not enabled/i);
    }));

  it("provisions an FA on the group's connect account and persists ids on the FUND wallet", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await provisionFundFinancialAccountAction(group.id, created.fundId!);
      expect(result.success).toBe(true);
      expect(result.financialAccountId).toBe("fa_fund_1");
      expect(vi.mocked(createTreasuryFinancialAccount)).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedAccountId: "acct_host_fund",
          metadata: expect.objectContaining({
            ownerId: created.fundId,
            parentGroupId: group.id,
            treasuryKind: "fund",
          }),
        }),
      );

      const fundWallet = await getFundWalletRow(created.fundId!);
      const meta = fundWallet!.metadata as Record<string, unknown>;
      expect(meta.stripeFinancialAccountId).toBe("fa_fund_1");
      expect(meta.stripeHostConnectAccountId).toBe("acct_host_fund");
      expect(meta.walletKind).toBe("fund");
    }));

  it("is idempotent — a second call returns the existing FA without a new Stripe call", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const first = await provisionFundFinancialAccountAction(group.id, created.fundId!);
      expect(first.success).toBe(true);
      const second = await provisionFundFinancialAccountAction(group.id, created.fundId!);
      expect(second.success).toBe(true);
      expect(second.financialAccountId).toBe("fa_fund_1");
      expect(vi.mocked(createTreasuryFinancialAccount)).toHaveBeenCalledTimes(1);
    }));

  it("requires the group's connect account to exist", () =>
    withTestTransaction(async (testDb) => {
      const admin = await createTestAgent(testDb);
      const group = await createTestGroup(testDb, { metadata: { adminIds: [admin.id] } });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await provisionFundFinancialAccountAction(group.id, created.fundId!);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/payment account/i);
    }));
});

describe("issueFundCardAction", () => {
  it("refuses when Issuing is not enabled", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      const created = await createFundAction(group.id, { name: "Ops Fund" });
      vi.mocked(isIssuingEnabled).mockReturnValue(false);

      const result = await issueFundCardAction(group.id, created.fundId!);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not enabled/i);
    }));

  it("requires the fund FA to exist first", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await issueFundCardAction(group.id, created.fundId!);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/provision/i);
    }));

  it("creates the cardholder once and issues a card tethered to the fund FA", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      await provisionFundFinancialAccountAction(group.id, created.fundId!);
      const result = await issueFundCardAction(group.id, created.fundId!, { spendingLimitCents: 30_000 });

      expect(result.success).toBe(true);
      expect(result.cardId).toBe("ic_fund_1");
      expect(result.last4).toBe("1234");
      expect(vi.mocked(createIssuingCardholder)).toHaveBeenCalledWith(
        expect.objectContaining({ connectedAccountId: "acct_host_fund", name: "Ops Fund" }),
      );
      expect(vi.mocked(createTreasuryIssuingCard)).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedAccountId: "acct_host_fund",
          cardholderId: "ich_fund_1",
          financialAccountId: "fa_fund_1",
          spendingLimitCents: 30_000,
        }),
      );

      // Cardholder id persisted → second card reuses it.
      await issueFundCardAction(group.id, created.fundId!);
      expect(vi.mocked(createIssuingCardholder)).toHaveBeenCalledTimes(1);
    }));

  it("rejects a non-positive spending limit", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await issueFundCardAction(group.id, created.fundId!, { spendingLimitCents: -5 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/spending limit/i);
    }));
});

// =============================================================================
// getGroupTreasuryFundsOverviewAction
// =============================================================================

describe("getGroupTreasuryFundsOverviewAction", () => {
  it("returns funds with balances, assignments, FA balance, cards, and subgroup options", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group, subgroup } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund", description: "Day-to-day" });
      await assignSubgroupToFundAction(group.id, created.fundId!, subgroup.id);
      await transferFundBalanceAction(group.id, created.fundId!, 4_000, "to_fund");
      await provisionFundFinancialAccountAction(group.id, created.fundId!);
      await issueFundCardAction(group.id, created.fundId!);

      const result = await getGroupTreasuryFundsOverviewAction(group.id);
      expect(result.success).toBe(true);
      const overview = result.overview!;
      expect(overview.treasuryEnabled).toBe(true);
      expect(overview.issuingEnabled).toBe(true);
      expect(overview.groupConnectAccountId).toBe("acct_host_fund");
      expect(overview.mainTreasuryBalanceCents).toBe(16_000);

      const row = overview.funds.find((fund) => fund.fundId === created.fundId);
      expect(row).toBeDefined();
      expect(row!.name).toBe("Ops Fund");
      expect(row!.description).toBe("Day-to-day");
      expect(row!.archived).toBe(false);
      expect(row!.balanceCents).toBe(4_000);
      expect(row!.assignedSubgroups).toEqual([{ id: subgroup.id, name: "Garden Circle" }]);
      expect(row!.financialAccountId).toBe("fa_fund_1");
      expect(row!.faCashCents).toBe(7_500);
      expect(row!.cards).toHaveLength(1);
      expect(row!.cards[0].last4).toBe("1234");

      const option = overview.subgroups.find((entry) => entry.id === subgroup.id);
      expect(option).toBeDefined();
      expect(option!.assignedFundId).toBe(created.fundId);
    }));

  it("degrades FA data to nulls when the fund has no banking binding", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const created = await createFundAction(group.id, { name: "Ops Fund" });
      const result = await getGroupTreasuryFundsOverviewAction(group.id);
      expect(result.success).toBe(true);

      const row = result.overview!.funds.find((fund) => fund.fundId === created.fundId);
      expect(row!.financialAccountId).toBeNull();
      expect(row!.faCashCents).toBeNull();
      expect(row!.cards).toEqual([]);
    }));

  it("rejects a non-admin caller", () =>
    withTestTransaction(async (testDb) => {
      const { group } = await seedTreasuryFunds(testDb);
      const outsider = await createTestAgent(testDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await getGroupTreasuryFundsOverviewAction(group.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unable to load/i);
    }));

  it("only surfaces this group's fund resources", () =>
    withTestTransaction(async (testDb) => {
      const { admin, group } = await seedTreasuryFunds(testDb);
      const otherAdmin = await createTestAgent(testDb);
      const otherGroup = await createTestGroup(testDb, { metadata: { adminIds: [otherAdmin.id] } });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(otherAdmin.id));
      await createFundAction(otherGroup.id, { name: "Other Ops" });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      await createFundAction(group.id, { name: "Ops Fund" });

      const result = await getGroupTreasuryFundsOverviewAction(group.id);
      expect(result.success).toBe(true);
      expect(result.overview!.funds.map((fund) => fund.name)).toEqual(["Ops Fund"]);
    }));
});
