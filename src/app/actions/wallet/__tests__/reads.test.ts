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

vi.mock("@/lib/wallet", () => ({
  getOrCreateWallet: vi.fn().mockResolvedValue({
    id: "wallet-123",
    balanceCents: 5000,
    metadata: {},
  }),
  getWalletBalance: vi.fn().mockResolvedValue({
    walletId: "wallet-123",
    balanceCents: 5000,
    currency: "usd",
    type: "personal",
  }),
  getUserWallets: vi.fn().mockResolvedValue([
    {
      walletId: "wallet-123",
      balanceCents: 5000,
      currency: "usd",
      type: "personal",
    },
  ]),
  getTransactionHistory: vi.fn().mockResolvedValue({
    transactions: [],
    total: 0,
  }),
}));

vi.mock("@/lib/stripe-connect", () => ({
  getConnectBalance: vi.fn().mockResolvedValue({ availableCents: 0, pendingCents: 0 }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { getOrCreateWallet, getWalletBalance, getUserWallets, getTransactionHistory } from "@/lib/wallet";
import {
  getMyWalletAction,
  getMyWalletsAction,
  getGroupWalletAction,
  getAgentEthAddressAction,
  getTransactionHistoryAction,
} from "../reads";

// =============================================================================
// Constants
// =============================================================================

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

// =============================================================================
// Tests
// =============================================================================

describe("wallet read actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // getMyWalletAction
  // ===========================================================================

  describe("getMyWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getMyWalletAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns wallet balance on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMyWalletAction();

        expect(result.success).toBe(true);
        expect(result.wallet).toBeDefined();
        expect(getOrCreateWallet).toHaveBeenCalledWith(user.id, "personal");
      }));
  });

  // ===========================================================================
  // getMyWalletsAction
  // ===========================================================================

  describe("getMyWalletsAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getMyWalletsAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns all user wallets on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMyWalletsAction();

        expect(result.success).toBe(true);
        expect(result.wallets).toBeDefined();
        expect(result.wallets).toHaveLength(1);
        expect(getUserWallets).toHaveBeenCalledWith(user.id);
      }));
  });

  // ===========================================================================
  // getGroupWalletAction
  // ===========================================================================

  describe("getGroupWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getGroupWalletAction(VALID_UUID);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for invalid group UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getGroupWalletAction("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid group");
      }));

    it("returns error when user is not a group member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getGroupWalletAction(group.id);

        expect(result.success).toBe(false);
        expect(result.error).toContain("member");
      }));

    it("returns group wallet when user is a member", () =>
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

        const result = await getGroupWalletAction(group.id);

        expect(result.success).toBe(true);
        expect(result.wallet).toBeDefined();
      }));

    it("returns group wallet when user is the creator", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getGroupWalletAction(group.id);

        expect(result.success).toBe(true);
        expect(result.wallet).toBeDefined();
      }));
  });

  // ===========================================================================
  // getAgentEthAddressAction
  // ===========================================================================

  describe("getAgentEthAddressAction", () => {
    it("returns null for invalid UUID", () =>
      withTestTransaction(async () => {
        const result = await getAgentEthAddressAction("not-a-uuid");

        expect(result.ethAddress).toBeNull();
      }));

    it("returns null for empty agentId", () =>
      withTestTransaction(async () => {
        const result = await getAgentEthAddressAction("");

        expect(result.ethAddress).toBeNull();
      }));

    it("returns null when no wallet exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);

        const result = await getAgentEthAddressAction(user.id);

        expect(result.ethAddress).toBeNull();
      }));

    it("returns ethAddress when wallet has one", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestWallet(db, user.id, {
          ethAddress: "0x1234567890abcdef1234567890abcdef12345678",
        } as Record<string, unknown>);

        const result = await getAgentEthAddressAction(user.id);

        expect(result.ethAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
      }));
  });

  // ===========================================================================
  // getTransactionHistoryAction
  // ===========================================================================

  describe("getTransactionHistoryAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getTransactionHistoryAction();

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns transaction history on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getTransactionHistoryAction({ limit: 10, offset: 0 });

        expect(result.success).toBe(true);
        expect(result.transactions).toBeDefined();
        expect(result.total).toBeDefined();
        expect(getTransactionHistory).toHaveBeenCalled();
      }));

    it("passes pagination options to getTransactionHistory", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await getTransactionHistoryAction({ limit: 20, offset: 5 });

        expect(getTransactionHistory).toHaveBeenCalledWith(
          "wallet-123",
          { limit: 20, offset: 5 },
        );
      }));
  });
});
