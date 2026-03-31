import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { resources } from "@/db/schema";

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

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
  RATE_LIMITS: {
    WALLET: { limit: 10, windowMs: 60000 },
  },
}));

vi.mock("@/lib/client-ip", () => ({
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

const mockStripeRefundsCreate = vi.fn().mockResolvedValue({ id: "re_test_123" });
const mockStripePaymentIntentsRetrieve = vi.fn().mockResolvedValue({
  id: "pi_test_123",
  amount: 1000,
  status: "succeeded",
});

vi.mock("@/lib/billing", () => ({
  getStripe: vi.fn(() => ({
    refunds: { create: mockStripeRefundsCreate },
    paymentIntents: { retrieve: mockStripePaymentIntentsRetrieve },
  })),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { requestRefundAction } from "../refund";

// =============================================================================
// Tests
// =============================================================================

describe("refund actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
    mockStripeRefundsCreate.mockResolvedValue({ id: "re_test_123" });
    mockStripePaymentIntentsRetrieve.mockResolvedValue({
      id: "pi_test_123",
      amount: 1000,
      status: "succeeded",
    });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe("authentication", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await requestRefundAction("receipt-id");
        expect(result).toEqual({ success: false, error: "Not authenticated" });
      }));
  });

  // ===========================================================================
  // Rate limiting
  // ===========================================================================

  describe("rate limiting", () => {
    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValue({ success: false, resetMs: 30000 });

        const result = await requestRefundAction("receipt-id");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many refund requests");
      }));
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe("validation", () => {
    it("returns error when receipt does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction("00000000-0000-0000-0000-000000000000");
        expect(result).toEqual({ success: false, error: "Receipt not found" });
      }));

    it("returns error when receipt is not owned by the user", () =>
      withTestTransaction(async (db) => {
        const owner = await createTestAgent(db);
        const other = await createTestAgent(db);

        const receipt = await createTestResource(db, owner.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 1000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Not authorized" });
      }));

    it("returns error when refund was already requested", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            status: "refund_requested",
            stripePaymentIntentId: "pi_test_123",
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Refund already requested" });
      }));

    it("returns error when receipt was already refunded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            status: "refunded",
            stripePaymentIntentId: "pi_test_123",
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Refund already requested" });
      }));

    it("returns error when no payment intent is found", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {},
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "No payment intent found" });
      }));
  });

  // ===========================================================================
  // Stripe verification
  // ===========================================================================

  describe("Stripe verification", () => {
    it("returns error when payment intent amount does not match receipt", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 5000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        mockStripePaymentIntentsRetrieve.mockResolvedValue({
          id: "pi_test_123",
          amount: 1000,
          status: "succeeded",
        });

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Payment verification failed" });
      }));

    it("returns error when payment intent is not in succeeded state", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 1000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        mockStripePaymentIntentsRetrieve.mockResolvedValue({
          id: "pi_test_123",
          amount: 1000,
          status: "pending",
        });

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Payment is not in a refundable state" });
      }));
  });

  // ===========================================================================
  // Successful refund
  // ===========================================================================

  describe("successful refund", () => {
    it("creates Stripe refund and updates receipt status", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const seller = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 1000,
            sellerAgentId: seller.id,
            originalListingId: "listing-123",
            priceCents: 900,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);

        expect(result).toEqual({ success: true });

        // Verify Stripe refund was created
        expect(mockStripeRefundsCreate).toHaveBeenCalledWith({
          payment_intent: "pi_test_123",
        });

        // Verify receipt was updated
        const [updated] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, receipt.id));
        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.status).toBe("refund_requested");
        expect(meta.refundRequestedAt).toBeDefined();
      }));

    it("returns error when Stripe refund creation fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 1000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        mockStripeRefundsCreate.mockRejectedValueOnce(new Error("Stripe API error"));

        const result = await requestRefundAction(receipt.id);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Refund failed");
      }));

    it("allows refund when totalCents is zero (free purchase edge case)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 0,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result.success).toBe(true);
      }));
  });
});
