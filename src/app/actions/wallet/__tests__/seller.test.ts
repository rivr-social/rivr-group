import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
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
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getConnectBalance, createPayout } from "@/lib/stripe-connect";
import {
  setupConnectAccountAction,
  getConnectStatusAction,
  getConnectBalanceAction,
  releaseTestConnectBalanceToWalletAction,
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

    it("returns onboarding URL on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setupConnectAccountAction();

        expect(result.success).toBe(true);
        expect(result.url).toBeDefined();
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

  // ===========================================================================
  // requestPayoutAction
  // ===========================================================================

  describe("requestPayoutAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await requestPayoutAction(5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(0);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await requestPayoutAction(5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error when insufficient available balance", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getConnectBalance).mockResolvedValueOnce({
          availableCents: 100,
          pendingCents: 0,
        });

        const result = await requestPayoutAction(5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Insufficient");
      }));

    it("returns payoutId on successful payout", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(3000);

        expect(result.success).toBe(true);
        expect(result.payoutId).toBe("po_test_123");
        expect(createPayout).toHaveBeenCalledWith("acct_test_123", 3000, "standard");
      }));

    it("passes instant speed to createPayout", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestPayoutAction(2000, "instant");

        expect(result.success).toBe(true);
        expect(createPayout).toHaveBeenCalledWith("acct_test_123", 2000, "instant");
      }));
  });
});
