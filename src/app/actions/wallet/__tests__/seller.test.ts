import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestWallet } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

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
    WALLET: { limit: 100, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/stripe-connect", () => ({
  getConnectBalance: vi.fn().mockResolvedValue({ availableCents: 5000, pendingCents: 1000 }),
  createConnectAccount: vi.fn().mockResolvedValue({ id: "acct_test_123" }),
  createAccountLink: vi.fn().mockResolvedValue("https://connect.stripe.com/setup/test"),
  getAccountStatus: vi.fn().mockResolvedValue({
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
  }),
  createPayout: vi.fn().mockResolvedValue({ id: "po_test_123" }),
  createLoginLink: vi.fn().mockResolvedValue("https://dashboard.stripe.com/test"),
}));

vi.mock("@/lib/wallet", () => ({
  getSettlementWalletForAgent: vi.fn().mockResolvedValue({
    id: "wallet-123",
    type: "personal",
    metadata: { stripeConnectAccountId: "acct_test_123" },
  }),
  consumeWalletCapital: vi.fn().mockResolvedValue([
    {
      entryId: "capital-1",
      amountCents: 500,
      settlementStatus: "cleared",
      availableOn: null,
      metadata: {},
    },
  ]),
  restoreWalletCapitalFromConsumptions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/connect-payout", () => ({
  settleConnectPayout: vi.fn().mockResolvedValue({
    status: "paid",
    transferId: "tr_global_123",
  }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getConnectBalance, createPayout } from "@/lib/stripe-connect";
import {
  consumeWalletCapital,
  getSettlementWalletForAgent,
  restoreWalletCapitalFromConsumptions,
} from "@/lib/wallet";
import { settleConnectPayout } from "@/lib/connect-payout";
import { wallets, walletTransactions } from "@/db/schema";
import { eq } from "drizzle-orm";

const PAYOUT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
import {
  setupConnectAccountAction,
  getConnectStatusAction,
  getConnectBalanceAction,
  releaseTestConnectBalanceToWalletAction,
  resolveWalletToConnectAction,
  requestPayoutAction,
} from "../seller";

// =============================================================================
// Tests
// =============================================================================

describe("seller actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // setupConnectAccountAction
  // ===========================================================================

  describe("setupConnectAccountAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await setupConnectAccountAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("fails closed when the Global onboarding lane is not enabled", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setupConnectAccountAction();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not enabled yet/i);
      }));
  });

  // ===========================================================================
  // getConnectStatusAction
  // ===========================================================================

  describe("getConnectStatusAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getConnectStatusAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns account status on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getConnectStatusAction();

        expect(result.success).toBe(true);
        expect(result.status).toBeDefined();
        expect(result.status?.hasAccount).toBe(true);
        expect(result.status?.chargesEnabled).toBe(true);
      }));
  });

  // ===========================================================================
  // getConnectBalanceAction
  // ===========================================================================

  describe("getConnectBalanceAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getConnectBalanceAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns balance on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getConnectBalanceAction();

        expect(result.success).toBe(true);
        expect(result.balance).toBeDefined();
        expect(result.balance?.availableCents).toBe(5000);
        expect(result.balance?.pendingCents).toBe(1000);
      }));
  });

  // ===========================================================================
  // releaseTestConnectBalanceToWalletAction
  // ===========================================================================

  describe("releaseTestConnectBalanceToWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await releaseTestConnectBalanceToWalletAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));
  });

  describe("resolveWalletToConnectAction", () => {
    it("submits a corridor-neutral obligation to Global using cleared capital", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const wallet = await createTestWallet(db, user.id, { balanceCents: 1000 });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getSettlementWalletForAgent).mockResolvedValueOnce(wallet);

        const result = await resolveWalletToConnectAction(500);

        expect(result.success).toBe(true);
        expect(consumeWalletCapital).toHaveBeenCalledWith(
          expect.anything(),
          wallet.id,
          1000,
          500,
          { clearedOnly: true },
        );
        expect(settleConnectPayout).toHaveBeenCalledWith(
          expect.objectContaining({
            payeeAgentId: user.id,
            amountCents: 500,
            metadata: expect.objectContaining({ corridor: "auto" }),
          }),
        );
        const [walletAfter] = await db
          .select()
          .from(wallets)
          .where(eq(wallets.id, wallet.id));
        expect(walletAfter.balanceCents).toBe(500);
      }));

    it("does not compensate an ambiguous Global submission", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const wallet = await createTestWallet(db, user.id, { balanceCents: 1000 });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getSettlementWalletForAgent).mockResolvedValueOnce(wallet);
        vi.mocked(settleConnectPayout).mockResolvedValueOnce({
          status: "error",
          detail: "timeout",
        });

        const result = await resolveWalletToConnectAction(500);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/awaiting reconciliation/i);
        expect(restoreWalletCapitalFromConsumptions).not.toHaveBeenCalled();
        const [walletAfter] = await db
          .select()
          .from(wallets)
          .where(eq(wallets.id, wallet.id));
        expect(walletAfter.balanceCents).toBe(500);
        const [payoutRow] = await db
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.fromWalletId, wallet.id));
        expect(payoutRow.status).toBe("submission_unknown");
      }));
  });

  // ===========================================================================
  // requestPayoutAction
  // ===========================================================================

  describe("requestPayoutAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await requestPayoutAction(5000, "standard", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(0, "standard", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await requestPayoutAction(5000, "standard", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("does not inspect a local Connect balance before rejecting direct payout", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getConnectBalance).mockResolvedValueOnce({
          availableCents: 100,
          pendingCents: 0,
        });

        const result = await requestPayoutAction(5000, "standard", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/owned by Global/i);
        expect(getConnectBalance).not.toHaveBeenCalled();
      }));

    it("rejects direct bank payout execution on Group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(3000, "standard", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/owned by Global/i);
        expect(createPayout).not.toHaveBeenCalled();
      }));

    it("does not use a local Stripe payout for instant requests", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(2000, "instant", undefined, PAYOUT_REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/owned by Global/i);
        expect(createPayout).not.toHaveBeenCalled();
      }));
  });
});
