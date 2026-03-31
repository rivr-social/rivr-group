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

vi.mock("@/lib/wallet", () => ({
  getOrCreateWallet: vi.fn().mockResolvedValue({ id: "wallet-123", balanceCents: 50000 }),
  getWalletBalance: vi.fn().mockResolvedValue({ balanceCents: 50000 }),
  purchaseFromWallet: vi.fn().mockResolvedValue(undefined),
  getPlatformWallet: vi.fn().mockResolvedValue({ id: "platform-wallet" }),
  getSettlementWalletForAgent: vi.fn().mockResolvedValue({ id: "seller-wallet", type: "personal", metadata: {} }),
}));

vi.mock("@/lib/fees", () => ({
  calculateLegacyCheckoutFeesCents: vi.fn().mockReturnValue({
    subtotalCents: 1000,
    platformFeeCents: 50,
    salesTaxCents: 0,
    paymentFeeCents: 0,
    totalCents: 1050,
  }),
}));

vi.mock("@/lib/permissions", () => ({
  canView: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/post-offer-deals", () => ({
  resolvePostOfferingDeal: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/queries/resources", () => ({
  getResource: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/queries/agents", () => ({
  getAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/billing", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_test_123"),
  getStripe: vi.fn().mockReturnValue({
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/test" }),
      },
    },
    paymentIntents: {
      create: vi.fn().mockResolvedValue({ client_secret: "pi_test_secret" }),
    },
  }),
}));

vi.mock("@/lib/booking-slots", () => ({
  consumeBookingSlot: vi.fn().mockReturnValue({}),
  hasBookableSchedule: vi.fn().mockReturnValue(false),
  isBookingSlotAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("stripe", async () => {
  const { setupStripeMock } = await import("@/test/external-mocks");
  return setupStripeMock();
});

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getResource } from "@/lib/queries/resources";
import {
  purchaseWithWalletAction,
  estimateEventTicketCheckoutAction,
  createEventTicketCheckoutAction,
  purchaseEventTicketsWithWalletAction,
} from "../purchases";

// =============================================================================
// Constants
// =============================================================================

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

// =============================================================================
// Tests
// =============================================================================

describe("wallet purchase actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // purchaseWithWalletAction
  // ===========================================================================

  describe("purchaseWithWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await purchaseWithWalletAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await purchaseWithWalletAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error for invalid listing UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await purchaseWithWalletAction("not-a-uuid", 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid listing");
      }));

    it("returns error for non-positive subtotal", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await purchaseWithWalletAction(VALID_UUID, 0);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when listing is not found", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getResource).mockResolvedValueOnce(null);

        const result = await purchaseWithWalletAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
      }));

    it("returns error when trying to purchase own listing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getResource).mockResolvedValueOnce({
          id: VALID_UUID,
          ownerId: user.id,
          type: "listing",
          name: "My Listing",
          metadata: { listingType: "product", totalPriceCents: 1000 },
          deletedAt: null,
        } as ReturnType<typeof getResource> extends Promise<infer R> ? NonNullable<R> : never);

        const result = await purchaseWithWalletAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("own listing");
      }));

    it("returns error when listing has no price", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getResource).mockResolvedValueOnce({
          id: VALID_UUID,
          ownerId: "seller-id",
          type: "listing",
          name: "Free Listing",
          metadata: { listingType: "product", totalPriceCents: 0 },
          deletedAt: null,
        } as ReturnType<typeof getResource> extends Promise<infer R> ? NonNullable<R> : never);

        const result = await purchaseWithWalletAction(VALID_UUID, 1000);

        expect(result.success).toBe(false);
        expect(result.error).toContain("no price");
      }));
  });

  // ===========================================================================
  // estimateEventTicketCheckoutAction
  // ===========================================================================

  describe("estimateEventTicketCheckoutAction", () => {
    it("returns error for non-positive subtotal", () =>
      withTestTransaction(async () => {
        const result = await estimateEventTicketCheckoutAction(0);

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error for negative subtotal", () =>
      withTestTransaction(async () => {
        const result = await estimateEventTicketCheckoutAction(-500);

        expect(result.success).toBe(false);
      }));

    it("returns breakdown for valid subtotal", () =>
      withTestTransaction(async () => {
        const result = await estimateEventTicketCheckoutAction(8500);

        expect(result.success).toBe(true);
        expect(result.breakdown).toBeDefined();
        expect(result.breakdown?.subtotalCents).toBe(1000);
      }));
  });

  // ===========================================================================
  // createEventTicketCheckoutAction
  // ===========================================================================

  describe("createEventTicketCheckoutAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createEventTicketCheckoutAction(VALID_UUID, [
          { ticketProductId: VALID_UUID, quantity: 1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error for invalid event UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventTicketCheckoutAction("not-a-uuid", [
          { ticketProductId: VALID_UUID, quantity: 1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid event");
      }));

    it("returns error when no valid selections provided", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventTicketCheckoutAction(VALID_UUID, [
          { ticketProductId: "bad-id", quantity: -1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Select at least one ticket");
      }));
  });

  // ===========================================================================
  // purchaseEventTicketsWithWalletAction
  // ===========================================================================

  describe("purchaseEventTicketsWithWalletAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await purchaseEventTicketsWithWalletAction(VALID_UUID, [
          { ticketProductId: VALID_UUID, quantity: 1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await purchaseEventTicketsWithWalletAction(VALID_UUID, [
          { ticketProductId: VALID_UUID, quantity: 1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error for invalid event UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await purchaseEventTicketsWithWalletAction("not-a-uuid", [
          { ticketProductId: VALID_UUID, quantity: 1 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid event");
      }));

    it("returns error when no valid selections provided", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await purchaseEventTicketsWithWalletAction(VALID_UUID, [
          { ticketProductId: "bad-id", quantity: 0 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Select at least one ticket");
      }));
  });
});
