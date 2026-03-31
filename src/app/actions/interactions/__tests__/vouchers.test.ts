import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger, resources } from "@/db/schema";

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
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 100, windowMs: 60000 },
    WALLET: { limit: 50, windowMs: 60000 },
    SETTINGS: { limit: 20, windowMs: 60000 },
  },
}));

vi.mock("@/lib/booking-slots", () => ({
  isBookingSlotAvailable: vi.fn().mockReturnValue(true),
  consumeBookingSlot: vi.fn().mockImplementation((meta: Record<string, unknown>) => ({ ...meta })),
  hasBookableSchedule: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/actions/create-resources", () => ({
  hasGroupWriteAccess: vi.fn().mockResolvedValue(false),
  createPostResource: vi.fn().mockResolvedValue({ success: true }),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  sendVoucherAction,
  createVoucherAction,
  claimVoucherAction,
  redeemVoucherAction,
  fetchVoucherEscrowStateAction,
} from "../vouchers";

// =============================================================================
// Tests
// =============================================================================

describe("voucher interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // sendVoucherAction
  // ---------------------------------------------------------------------------

  describe("sendVoucherAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await sendVoucherAction(
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid voucher or recipient ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendVoucherAction("not-a-uuid", "also-bad");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("returns error for invalid recipient ID only", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendVoucherAction(
          "11111111-1111-4111-8111-111111111111",
          "not-a-uuid"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("creates a voucher-gift ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, sender.id, {
          name: "Test Voucher",
          type: "voucher",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendVoucherAction(
          voucher.id,
          recipient.id,
          "Enjoy this voucher!"
        );

        expect(result).toEqual({
          success: true,
          message: "Voucher sent.",
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "gift"),
              sql`${ledger.metadata}->>'interactionType' = 'voucher-gift'`
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(recipient.id);
        expect(entries[0].resourceId).toBe(voucher.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.message).toBe("Enjoy this voucher!");
        expect(meta.voucherId).toBe(voucher.id);
      }));

    it("sends voucher with empty message when none provided", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, sender.id, {
          name: "Another Voucher",
          type: "voucher",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendVoucherAction(voucher.id, recipient.id);

        expect(result.success).toBe(true);

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "gift")
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.message).toBe("");
      }));

    it("creates a comment ledger entry when contextId is provided", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, sender.id, {
          name: "Gift Voucher",
          type: "voucher",
        });
        const post = await createTestResource(txDb, recipient.id, {
          name: "Post",
          type: "post",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        await sendVoucherAction(
          voucher.id,
          recipient.id,
          "For your great work!",
          post.id
        );

        const comments = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "comment"),
              eq(ledger.objectId, post.id)
            )
          );

        expect(comments.length).toBe(1);
        const meta = comments[0].metadata as Record<string, unknown>;
        expect(meta.isGift).toBe(true);
        expect(meta.giftType).toBe("voucher");
        expect(meta.voucherId).toBe(voucher.id);
      }));
  });

  // ---------------------------------------------------------------------------
  // createVoucherAction
  // ---------------------------------------------------------------------------

  describe("createVoucherAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createVoucherAction({
          title: "Test",
          description: "Test desc",
          category: "service",
          ringId: "11111111-1111-4111-8111-111111111111",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid ring ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Childcare swap",
          description: "Two hours of childcare help.",
          category: "service",
          ringId: "not-a-uuid",
        });

        expect(result).toEqual({
          success: false,
          message: "Invalid ring ID.",
        });
      }));

    it("returns error when title is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "   ",
          description: "Some desc",
          category: "service",
          ringId: "11111111-1111-4111-8111-111111111111",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("title is required");
      }));

    it("returns error when description is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Valid Title",
          description: "   ",
          category: "service",
          ringId: "11111111-1111-4111-8111-111111111111",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("description is required");
      }));

    it("returns error when ring is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Valid Title",
          description: "Valid desc",
          category: "service",
          ringId: "11111111-1111-4111-8111-111111111111",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Ring not found");
      }));

    it("creates a voucher resource scoped to a ring", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Childcare swap",
          description: "Two hours of childcare help.",
          category: "service",
          ringId: ring.id,
          estimatedValue: 40,
          maxClaims: 2,
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeTruthy();

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.type).toBe("voucher");
        expect(created.tags).toContain(ring.id);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.resourceKind).toBe("voucher");
        expect(meta.ringId).toBe(ring.id);
        expect(meta.status).toBe("available");
        expect(meta.maxClaims).toBe(2);
        expect(meta.estimatedValue).toBe(40);
      }));
  });

  // ---------------------------------------------------------------------------
  // claimVoucherAction
  // ---------------------------------------------------------------------------

  describe("claimVoucherAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await claimVoucherAction("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid voucher ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimVoucherAction("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid voucher ID");
      }));

    it("returns error when claiming own voucher", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const createResult = await createVoucherAction({
          title: "My voucher",
          description: "Cannot claim this",
          category: "service",
          ringId: ring.id,
        });

        const result = await claimVoucherAction(createResult.resourceId!);

        expect(result.success).toBe(false);
        expect(result.message).toContain("cannot claim your own");
      }));

    it("claims and redeems a voucher", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const claimant = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const createResult = await createVoucherAction({
          title: "Tool lending",
          description: "Borrow my wheelbarrow for a day.",
          category: "resource",
          ringId: ring.id,
        });

        expect(createResult.success).toBe(true);
        const voucherId = createResult.resourceId!;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(claimant.id));
        const claimResult = await claimVoucherAction(voucherId);
        expect(claimResult).toEqual({
          success: true,
          message: "Voucher claimed successfully.",
        });

        const [claimedVoucher] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, voucherId));

        const meta = claimedVoucher.metadata as Record<string, unknown>;
        expect(meta.status).toBe("claimed");
        expect(meta.claimedBy).toBe(claimant.id);
        expect(meta.currentClaims).toBe(1);
      }));

    it("returns error when voucher is already claimed", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const claimant1 = await createTestAgent(txDb);
        const claimant2 = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const createResult = await createVoucherAction({
          title: "Single claim voucher",
          description: "Only one claim allowed.",
          category: "service",
          ringId: ring.id,
          maxClaims: 1,
        });
        const voucherId = createResult.resourceId!;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(claimant1.id));
        await claimVoucherAction(voucherId);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(claimant2.id));
        const result = await claimVoucherAction(voucherId);

        expect(result.success).toBe(false);
        expect(result.message).toContain("no longer available");
      }));
  });

  // ---------------------------------------------------------------------------
  // redeemVoucherAction
  // ---------------------------------------------------------------------------

  describe("redeemVoucherAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await redeemVoucherAction("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid voucher ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await redeemVoucherAction("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid voucher ID");
      }));

    it("returns error when voucher is already redeemed", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, user.id, {
          name: "Redeemed Voucher",
          type: "voucher",
          metadata: { status: "completed" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await redeemVoucherAction(voucher.id);

        expect(result.success).toBe(false);
        expect(result.message).toContain("already been redeemed");
      }));

    it("returns error when non-claimant tries to redeem", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const claimant = await createTestAgent(txDb);
        const other = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, owner.id, {
          name: "Claimed Voucher",
          type: "voucher",
          metadata: { status: "claimed", claimedBy: claimant.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));

        const result = await redeemVoucherAction(voucher.id);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Only the claimant");
      }));

    it("redeems a claimed voucher successfully", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const claimant = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const createResult = await createVoucherAction({
          title: "Redeem me",
          description: "A redeemable voucher.",
          category: "resource",
          ringId: ring.id,
        });
        const voucherId = createResult.resourceId!;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(claimant.id));
        await claimVoucherAction(voucherId);

        const redeemResult = await redeemVoucherAction(voucherId);
        expect(redeemResult.success).toBe(true);
        expect(redeemResult.message).toContain("Voucher redeemed successfully.");

        const [redeemed] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, voucherId));

        const meta = redeemed.metadata as Record<string, unknown>;
        expect(meta.status).toBe("completed");
        expect(meta.redeemedBy).toBe(claimant.id);
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchVoucherEscrowStateAction
  // ---------------------------------------------------------------------------

  describe("fetchVoucherEscrowStateAction", () => {
    it("returns null for invalid voucher ID", async () => {
      const result = await fetchVoucherEscrowStateAction("not-a-uuid");

      expect(result).toBeNull();
    });

    it("returns null when voucher is not found", () =>
      withTestTransaction(async () => {
        const result = await fetchVoucherEscrowStateAction(
          "11111111-1111-4111-8111-111111111111"
        );

        expect(result).toBeNull();
      }));

    it("returns null when resource is not a voucher type", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const resource = await createTestResource(txDb, user.id, {
          name: "Not a voucher",
          type: "document",
        });

        const result = await fetchVoucherEscrowStateAction(resource.id);

        expect(result).toBeNull();
      }));

    it("returns escrow state for an available voucher", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const createResult = await createVoucherAction({
          title: "Escrow State Test",
          description: "Testing escrow state.",
          category: "service",
          ringId: ring.id,
        });

        const result = await fetchVoucherEscrowStateAction(createResult.resourceId!);

        expect(result).not.toBeNull();
        expect(result!.voucherId).toBe(createResult.resourceId);
        expect(result!.status).toBe("available");
        expect(result!.isOwner).toBe(true);
        expect(result!.canClaim).toBe(false); // owner cannot claim own voucher
      }));
  });
});
