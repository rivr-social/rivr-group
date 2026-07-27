import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ledger, resources } from "@/db/schema";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

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

import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { requestRefundAction } from "../refund";

describe("requestRefundAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
  });

  it("requires authentication", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(requestRefundAction("receipt-id")).resolves.toEqual({
        success: false,
        error: "Not authenticated",
      });
    }));

  it("enforces the refund rate limit", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(rateLimit).mockResolvedValue({ success: false, resetMs: 30_000 });

      const result = await requestRefundAction("receipt-id");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Too many refund requests");
    }));

  it("rejects a missing receipt", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      await expect(
        requestRefundAction("00000000-0000-0000-0000-000000000000"),
      ).resolves.toEqual({ success: false, error: "Receipt not found" });
    }));

  it("rejects a receipt owned by another actor", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const other = await createTestAgent(db);
      const receipt = await createTestResource(db, owner.id, {
        type: "receipt",
        metadata: { stripePaymentIntentId: "pi_test_123" },
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));

      await expect(requestRefundAction(receipt.id)).resolves.toEqual({
        success: false,
        error: "Not authorized",
      });
    }));

  it.each(["refund_requested", "refunded"])(
    "rejects a receipt with status %s",
    (status) =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            status,
            stripePaymentIntentId: "pi_test_123",
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await expect(requestRefundAction(receipt.id)).resolves.toEqual({
          success: false,
          error: "Refund already requested",
        });
      }),
  );

  it("rejects a receipt without a payment intent", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const receipt = await createTestResource(db, user.id, {
        type: "receipt",
        metadata: {},
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      await expect(requestRefundAction(receipt.id)).resolves.toEqual({
        success: false,
        error: "No payment intent found",
      });
    }));

  it("fails closed when the Global refund lane is not enabled", () =>
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

      const result = await requestRefundAction(receipt.id);

      // Global is the only Stripe platform, so this instance submits an
      // obligation rather than refunding. With the lane disabled it must refuse
      // and leave the receipt untouched, never look settled.
      expect(result).toEqual({
        success: false,
        error: "Refunds are not enabled yet. Please contact the seller.",
      });

      const [unchangedReceipt] = await db
        .select({ metadata: resources.metadata })
        .from(resources)
        .where(eq(resources.id, receipt.id));
      expect(unchangedReceipt.metadata).toEqual(
        expect.objectContaining({
          stripePaymentIntentId: "pi_test_123",
          totalCents: 1000,
        }),
      );
      expect((unchangedReceipt.metadata as Record<string, unknown>).status).toBeUndefined();

      const refundLedgerRows = await db
        .select({ id: ledger.id })
        .from(ledger)
        .where(eq(ledger.resourceId, receipt.id));
      expect(refundLedgerRows).toHaveLength(0);
    }));
});
