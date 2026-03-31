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

vi.mock("@/lib/eth-utils", () => ({
  isValidEthAddress: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/wallet", () => ({
  getOrCreateWallet: vi.fn().mockResolvedValue({ id: "wallet-123" }),
  setEthAddress: vi.fn().mockResolvedValue(undefined),
  recordEthPayment: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isValidEthAddress } from "@/lib/eth-utils";
import { setEthAddress, recordEthPayment } from "@/lib/wallet";
import { setEthAddressAction, recordEthPaymentAction } from "../ethereum";

// =============================================================================
// Constants
// =============================================================================

const VALID_ETH_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_TX_HASH = "0x" + "a".repeat(64);
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

// =============================================================================
// Tests
// =============================================================================

describe("ethereum wallet actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // setEthAddressAction
  // ===========================================================================

  describe("setEthAddressAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await setEthAddressAction(VALID_ETH_ADDRESS);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for invalid ETH address", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isValidEthAddress).mockReturnValueOnce(false);

        const result = await setEthAddressAction("not-an-address");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid Ethereum address");
      }));

    it("succeeds with valid ETH address", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setEthAddressAction(VALID_ETH_ADDRESS);

        expect(result.success).toBe(true);
        expect(setEthAddress).toHaveBeenCalled();
      }));

    it("allows clearing the ETH address with empty string", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setEthAddressAction("");

        expect(result.success).toBe(true);
      }));

    it("allows clearing the ETH address with whitespace", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setEthAddressAction("   ");

        expect(result.success).toBe(true);
      }));
  });

  // ===========================================================================
  // recordEthPaymentAction
  // ===========================================================================

  describe("recordEthPaymentAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          VALID_TX_HASH,
          "Payment for service",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          VALID_TX_HASH,
          "Payment",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error for invalid recipient UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          "not-a-uuid",
          2000,
          VALID_TX_HASH,
          "Payment",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid recipient");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          VALID_UUID,
          0,
          VALID_TX_HASH,
          "Payment",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error for invalid transaction hash format", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          "invalid-hash",
          "Payment",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("transaction hash format");
      }));

    it("returns error when description is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          VALID_TX_HASH,
          "   ",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Description is required");
      }));

    it("records ETH payment successfully", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          VALID_TX_HASH,
          "Payment for service",
        );

        expect(result.success).toBe(true);
        expect(recordEthPayment).toHaveBeenCalled();
      }));

    it("creates receipt resource when listingId is provided", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordEthPaymentAction(
          VALID_UUID,
          2000,
          VALID_TX_HASH,
          "Payment for listing",
          "listing-uuid",
        );

        expect(result.success).toBe(true);
        expect(result.receiptId).toBeDefined();
      }));
  });
});
