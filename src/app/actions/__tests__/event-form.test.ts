import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource, createMembership } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import type { NewResource, ResourceType, VisibilityLevel } from "@/db/schema";

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

vi.mock("@/app/actions/group-admin", () => ({
  isGroupAdmin: vi.fn().mockResolvedValue(false),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { fetchManagedGroupsAction, fetchEventTicketOfferingsAction } from "../event-form";
import { agents, resources } from "@/db/schema";

// =============================================================================
// Tests
// =============================================================================

describe("event-form actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
  });

  // ===========================================================================
  // fetchManagedGroupsAction
  // ===========================================================================

  describe("fetchManagedGroupsAction", () => {
    it("returns empty array when user is not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchManagedGroupsAction();
        expect(result).toEqual([]);
      }));

    it("returns groups where user is the creator", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id, groupType: "cooperative" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchManagedGroupsAction();

        const found = result.find((g) => g.id === group.id);
        expect(found).toBeDefined();
        expect(found?.name).toBe(group.name);
        expect(found?.groupType).toBe("cooperative");
      }));

    it("returns groups where user is in adminIds", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { adminIds: [user.id], groupType: "council" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchManagedGroupsAction();
        const found = result.find((g) => g.id === group.id);
        expect(found).toBeDefined();
      }));

    it("returns groups where isGroupAdmin returns true", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(true);

        const result = await fetchManagedGroupsAction();
        const found = result.find((g) => g.id === group.id);
        expect(found).toBeDefined();
      }));

    it("excludes soft-deleted groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestGroup(db, {
          metadata: { creatorId: user.id },
          deletedAt: new Date(),
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchManagedGroupsAction();
        expect(result.length).toBe(0);
      }));

    it("falls back to agent type when no groupType or placeType in metadata", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchManagedGroupsAction();
        const found = result.find((g) => g.id === group.id);
        expect(found?.groupType).toBe("organization");
      }));
  });

  // ===========================================================================
  // fetchEventTicketOfferingsAction
  // ===========================================================================

  describe("fetchEventTicketOfferingsAction", () => {
    it("returns empty array when user is not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchEventTicketOfferingsAction("some-event-id");
        expect(result).toEqual([]);
      }));

    it("returns empty array when eventId is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchEventTicketOfferingsAction("");
        expect(result).toEqual([]);
      }));

    it("returns ticket offerings for an event", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const eventId = "00000000-0000-0000-0000-000000000099";

        // Create a ticket listing resource
        await db.insert(resources).values({
          name: "General Admission",
          type: "listing" as ResourceType,
          ownerId: user.id,
          visibility: "public" as VisibilityLevel,
          metadata: {
            eventId,
            productKind: "ticket",
            totalPriceCents: 2500,
            ticketQuantity: 100,
            status: "active",
          },
          tags: [],
        } as NewResource);

        const result = await fetchEventTicketOfferingsAction(eventId);

        expect(result.length).toBe(1);
        expect(result[0].name).toBe("General Admission");
        expect(result[0].priceCents).toBe(2500);
        expect(result[0].quantity).toBe(100);
      }));

    it("extracts priceCents from ticketPriceCents when totalPriceCents is absent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const eventId = "00000000-0000-0000-0000-000000000098";
        await db.insert(resources).values({
          name: "VIP Ticket",
          type: "listing" as ResourceType,
          ownerId: user.id,
          visibility: "public" as VisibilityLevel,
          metadata: {
            eventId,
            productKind: "ticket",
            ticketPriceCents: 5000,
            status: "active",
          },
          tags: [],
        } as NewResource);

        const result = await fetchEventTicketOfferingsAction(eventId);
        expect(result[0].priceCents).toBe(5000);
      }));

    it("converts ticketPrice dollars to cents", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const eventId = "00000000-0000-0000-0000-000000000097";
        await db.insert(resources).values({
          name: "Student Ticket",
          type: "listing" as ResourceType,
          ownerId: user.id,
          visibility: "public" as VisibilityLevel,
          metadata: {
            eventId,
            productKind: "ticket",
            ticketPrice: 15.5,
            status: "active",
          },
          tags: [],
        } as NewResource);

        const result = await fetchEventTicketOfferingsAction(eventId);
        expect(result[0].priceCents).toBe(1550);
      }));

    it("excludes archived ticket offerings", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const eventId = "00000000-0000-0000-0000-000000000096";
        await db.insert(resources).values({
          name: "Archived Ticket",
          type: "listing" as ResourceType,
          ownerId: user.id,
          visibility: "public" as VisibilityLevel,
          metadata: {
            eventId,
            productKind: "ticket",
            totalPriceCents: 1000,
            status: "archived",
          },
          tags: [],
        } as NewResource);

        const result = await fetchEventTicketOfferingsAction(eventId);
        expect(result.length).toBe(0);
      }));

    it("generates fallback tierId when ticketTierId is absent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const eventId = "00000000-0000-0000-0000-000000000095";
        await db.insert(resources).values({
          name: "Basic",
          type: "listing" as ResourceType,
          ownerId: user.id,
          visibility: "public" as VisibilityLevel,
          metadata: {
            eventId,
            productKind: "ticket",
            totalPriceCents: 500,
          },
          tags: [],
        } as NewResource);

        const result = await fetchEventTicketOfferingsAction(eventId);
        expect(result[0].tierId).toBe("ticket-1");
      }));
  });
});
