import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestWallet,
  createTestLedgerEntry,
} from "@/test/fixtures";
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
    WALLET_DEPOSIT: { limit: 50, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/wallet", () => ({
  getOrCreateWallet: vi.fn().mockResolvedValue({ id: "wallet-123", balanceCents: 10000 }),
  createDepositIntent: vi.fn().mockResolvedValue({ clientSecret: "pi_test_secret" }),
  transferP2P: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/stripe-connect", () => ({
  getConnectBalance: vi.fn().mockResolvedValue({ availableCents: 0, pendingCents: 0 }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getOrCreateWallet, createDepositIntent, transferP2P } from "@/lib/wallet";
import {
  createDepositIntentAction,
  sendMoneyAction,
  depositToGroupWalletAction,
} from "../transfers";

// =============================================================================
// Constants
// =============================================================================

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const ANOTHER_UUID = "22222222-2222-4222-8222-222222222222";

// =============================================================================
// Tests
// =============================================================================

describe("wallet transfer actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // createDepositIntentAction
  // ===========================================================================

  describe("createDepositIntentAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createDepositIntentAction(5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await createDepositIntentAction(5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error when amount is not a positive integer", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDepositIntentAction(-100);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when amount is zero", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDepositIntentAction(0);

        expect(result.success).toBe(false);
      }));

    it("returns error when amount is below minimum", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDepositIntentAction(50); // MIN_DEPOSIT_CENTS = 100

        expect(result.success).toBe(false);
        expect(result.error).toContain("Minimum deposit");
      }));

    it("returns error when amount exceeds maximum", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDepositIntentAction(200_000); // MAX_DEPOSIT_CENTS = 100_000

        expect(result.success).toBe(false);
        expect(result.error).toContain("Maximum deposit");
      }));

    it("returns clientSecret on successful deposit intent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDepositIntentAction(5000);

        expect(result.success).toBe(true);
        expect(result.clientSecret).toBe("pi_test_secret");
        expect(getOrCreateWallet).toHaveBeenCalled();
        expect(createDepositIntent).toHaveBeenCalled();
      }));
  });

  // ===========================================================================
  // sendMoneyAction
  // ===========================================================================

  describe("sendMoneyAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await sendMoneyAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await sendMoneyAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error for invalid recipient UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendMoneyAction("not-a-uuid", 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid recipient");
      }));

    it("returns error when sending to self", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendMoneyAction(user.id, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("yourself");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendMoneyAction(VALID_UUID, 0);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when amount exceeds maximum", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendMoneyAction(VALID_UUID, 100_000); // MAX_TRANSFER_CENTS = 50_000

        expect(result.success).toBe(false);
        expect(result.error).toContain("Maximum transfer");
      }));

    it("succeeds with valid inputs", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendMoneyAction(VALID_UUID, 2500, "Shared meal");

        expect(result.success).toBe(true);
        expect(transferP2P).toHaveBeenCalled();
      }));
  });

  // ===========================================================================
  // depositToGroupWalletAction
  // ===========================================================================

  describe("depositToGroupWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await depositToGroupWalletAction(VALID_UUID, 5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for invalid group UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await depositToGroupWalletAction("bad-uuid", 5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid group");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await depositToGroupWalletAction(VALID_UUID, -100);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when amount exceeds maximum transfer", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await depositToGroupWalletAction(VALID_UUID, 100_000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Maximum transfer");
      }));

    it("returns error when user is not a group member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await depositToGroupWalletAction(group.id, 5000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("member");
      }));

    it("succeeds when user is a group member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        await createTestLedgerEntry(db, user.id, {
          verb: "belong",
          objectId: group.id,
          objectType: "agent",
          isActive: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await depositToGroupWalletAction(group.id, 5000);

        expect(result.success).toBe(true);
        expect(transferP2P).toHaveBeenCalled();
      }));
  });
});
