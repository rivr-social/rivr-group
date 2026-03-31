import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
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
  consumeBookingSlot: vi.fn().mockImplementation((meta: Record<string, unknown>) => ({ ...meta, slotConsumed: true })),
  hasBookableSchedule: vi.fn().mockReturnValue(false),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { isBookingSlotAvailable } from "@/lib/booking-slots";
import {
  createBookingAction,
  getOfferingBookingsAction,
} from "../bookings";

// =============================================================================
// Tests
// =============================================================================

describe("booking interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isBookingSlotAvailable).mockReturnValue(true);
  });

  // ---------------------------------------------------------------------------
  // createBookingAction
  // ---------------------------------------------------------------------------

  describe("createBookingAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createBookingAction({
          offeringId: "11111111-1111-4111-8111-111111111111",
          slotDate: "2026-04-01",
          slotTime: "10:00",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid offering ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBookingAction({
          offeringId: "not-a-uuid",
          slotDate: "2026-04-01",
          slotTime: "10:00",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid offering ID");
      }));

    it("returns error when date or time slot is missing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBookingAction({
          offeringId: "11111111-1111-4111-8111-111111111111",
          slotDate: "",
          slotTime: "",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("date and time slot are required");
      }));

    it("returns error when notes exceed max length", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBookingAction({
          offeringId: "11111111-1111-4111-8111-111111111111",
          slotDate: "2026-04-01",
          slotTime: "10:00",
          notes: "x".repeat(2001),
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("2000 characters");
      }));

    it("returns error when offering is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBookingAction({
          offeringId: "11111111-1111-4111-8111-111111111111",
          slotDate: "2026-04-01",
          slotTime: "10:00",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Offering not found");
      }));

    it("returns error when slot is unavailable", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const booker = await createTestAgent(txDb);
        const offering = await createTestResource(txDb, owner.id, {
          name: "Massage Session",
          type: "listing",
          metadata: { entityType: "offering" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(booker.id));
        vi.mocked(isBookingSlotAvailable).mockReturnValue(false);

        const result = await createBookingAction({
          offeringId: offering.id,
          slotDate: "2026-04-01",
          slotTime: "10:00",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("no longer available");
      }));

    it("returns error when booking own offering", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const offering = await createTestResource(txDb, owner.id, {
          name: "My Offering",
          type: "listing",
          metadata: { entityType: "offering" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const result = await createBookingAction({
          offeringId: offering.id,
          slotDate: "2026-04-01",
          slotTime: "10:00",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("cannot book your own");
      }));

    it("creates a booking with ledger entry on success", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const booker = await createTestAgent(txDb);
        const offering = await createTestResource(txDb, owner.id, {
          name: "Massage Session",
          type: "listing",
          metadata: { entityType: "offering" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(booker.id));

        const result = await createBookingAction({
          offeringId: offering.id,
          slotDate: "2026-04-01",
          slotTime: "10:00",
          notes: "Looking forward to it",
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain("Booking confirmed");

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, booker.id),
              eq(ledger.verb, "schedule"),
              sql`${ledger.metadata}->>'interactionType' = 'booking'`
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.slotDate).toBe("2026-04-01");
        expect(meta.slotTime).toBe("10:00");
        expect(meta.notes).toBe("Looking forward to it");
        expect(meta.bookingStatus).toBe("confirmed");
        expect(meta.sellerId).toBe(owner.id);
      }));
  });

  // ---------------------------------------------------------------------------
  // getOfferingBookingsAction
  // ---------------------------------------------------------------------------

  describe("getOfferingBookingsAction", () => {
    it("returns error for invalid offering ID", async () => {
      const result = await getOfferingBookingsAction("not-a-uuid");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Invalid offering ID");
      expect(result.bookings).toEqual([]);
    });

    it("returns empty bookings when no bookings exist", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const offering = await createTestResource(txDb, owner.id, {
          name: "Offering",
          type: "listing",
        });

        const result = await getOfferingBookingsAction(offering.id);

        expect(result.success).toBe(true);
        expect(result.bookings).toEqual([]);
      }));

    it("returns bookings for an offering", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const booker = await createTestAgent(txDb);
        const offering = await createTestResource(txDb, owner.id, {
          name: "Offering",
          type: "listing",
          metadata: { entityType: "offering" },
        });

        // Create a booking via the action
        vi.mocked(auth).mockResolvedValue(mockAuthSession(booker.id));
        await createBookingAction({
          offeringId: offering.id,
          slotDate: "2026-04-01",
          slotTime: "14:00",
          notes: "Afternoon session",
        });

        const result = await getOfferingBookingsAction(offering.id);

        expect(result.success).toBe(true);
        expect(result.bookings.length).toBe(1);
        expect(result.bookings[0].userId).toBe(booker.id);
        expect(result.bookings[0].slotDate).toBe("2026-04-01");
        expect(result.bookings[0].slotTime).toBe("14:00");
        expect(result.bookings[0].notes).toBe("Afternoon session");
        expect(result.bookings[0].status).toBe("confirmed");
      }));
  });
});
