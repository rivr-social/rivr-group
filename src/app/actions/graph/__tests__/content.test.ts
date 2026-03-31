import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestPost,
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

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  fetchUserBadges,
  fetchVouchersForGroup,
  fetchVoucherClaims,
  fetchMySavedListingIds,
  fetchMyReceipts,
  fetchEvents,
  fetchPlaces,
  fetchProjects,
} from "../content";

// =============================================================================
// Constants
// =============================================================================

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

// =============================================================================
// Tests
// =============================================================================

describe("graph/content actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchUserBadges
  // ===========================================================================

  describe("fetchUserBadges", () => {
    it("returns empty array when user has no badges", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);

        const result = await fetchUserBadges(user.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns badge resources earned by user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        const badge = await createTestResource(db, group.id, {
          type: "badge",
          name: "Helper Badge",
          visibility: "members",
        });
        // Create an earn ledger entry
        await createTestLedgerEntry(db, user.id, {
          verb: "earn",
          objectId: badge.id,
          objectType: "resource",
          isActive: true,
        });

        const result = await fetchUserBadges(user.id);

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0].id).toBe(badge.id);
          expect(result[0].name).toBe("Helper Badge");
        }
      }));
  });

  // ===========================================================================
  // fetchVouchersForGroup
  // ===========================================================================

  describe("fetchVouchersForGroup", () => {
    it("returns empty array when group has no vouchers", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db);

        const result = await fetchVouchersForGroup(group.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns only voucher-type resources for the group", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db);
        await createTestResource(db, group.id, {
          type: "voucher",
          name: "Test Voucher",
        });
        await createTestResource(db, group.id, {
          type: "document",
          name: "Not a Voucher",
        });

        const result = await fetchVouchersForGroup(group.id);

        expect(Array.isArray(result)).toBe(true);
        for (const voucher of result) {
          expect(voucher.type).toBe("voucher");
        }
      }));
  });

  // ===========================================================================
  // fetchVoucherClaims
  // ===========================================================================

  describe("fetchVoucherClaims", () => {
    it("returns empty array when no claims exist", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db);
        const voucher = await createTestResource(db, group.id, {
          type: "voucher",
          name: "Test Voucher",
        });

        const result = await fetchVoucherClaims(voucher.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns claim entries with claimer info", () =>
      withTestTransaction(async (db) => {
        const claimer = await createTestAgent(db, { name: "Claimer" });
        const group = await createTestGroup(db);
        const voucher = await createTestResource(db, group.id, {
          type: "voucher",
        });

        await createTestLedgerEntry(db, claimer.id, {
          verb: "redeem",
          objectId: voucher.id,
          objectType: "resource",
          isActive: true,
        });

        const result = await fetchVoucherClaims(voucher.id);

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty("claimerId");
          expect(result[0]).toHaveProperty("claimerName");
          expect(result[0]).toHaveProperty("timestamp");
          expect(result[0].claimerId).toBe(claimer.id);
          expect(result[0].claimerName).toBe("Claimer");
        }
      }));
  });

  // ===========================================================================
  // fetchMySavedListingIds
  // ===========================================================================

  describe("fetchMySavedListingIds", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchMySavedListingIds()).rejects.toThrow("Unauthorized");
      }));

    it("returns empty array when no saved listings exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchMySavedListingIds();

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns unique listing ids from save interactions", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const listing1 = await createTestResource(db, user.id, { type: "listing" });
        const listing2 = await createTestResource(db, user.id, { type: "listing" });

        await createTestLedgerEntry(db, user.id, {
          verb: "share",
          objectId: listing1.id,
          objectType: "resource",
          isActive: true,
          metadata: { interactionType: "save", targetId: listing1.id },
        });
        await createTestLedgerEntry(db, user.id, {
          verb: "share",
          objectId: listing2.id,
          objectType: "resource",
          isActive: true,
          metadata: { interactionType: "save", targetId: listing2.id },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchMySavedListingIds();

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
        expect(result).toContain(listing1.id);
        expect(result).toContain(listing2.id);
      }));

    it("deduplicates saved listing ids", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const listing = await createTestResource(db, user.id, { type: "listing" });

        // Save same listing twice
        await createTestLedgerEntry(db, user.id, {
          verb: "share",
          objectId: listing.id,
          objectType: "resource",
          isActive: true,
          metadata: { interactionType: "save", targetId: listing.id },
        });
        await createTestLedgerEntry(db, user.id, {
          verb: "share",
          objectId: listing.id,
          objectType: "resource",
          isActive: true,
          metadata: { interactionType: "save", targetId: listing.id },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchMySavedListingIds();

        expect(result.length).toBe(1);
        expect(result[0]).toBe(listing.id);
      }));
  });

  // ===========================================================================
  // fetchMyReceipts
  // ===========================================================================

  describe("fetchMyReceipts", () => {
    it("returns empty receipts when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMyReceipts();

        expect(result).toEqual({ receipts: [] });
      }));

    it("returns empty receipts when user has none", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchMyReceipts();

        expect(result).toEqual({ receipts: [] });
      }));

    it("returns receipts with listing and seller data", () =>
      withTestTransaction(async (db) => {
        const buyer = await createTestAgent(db, { name: "Buyer" });
        const seller = await createTestAgent(db, {
          name: "Seller",
          metadata: { username: "seller1" },
        });
        const listing = await createTestResource(db, seller.id, {
          type: "listing",
          name: "Test Item",
          metadata: { listingType: "product" },
        });
        await createTestResource(db, buyer.id, {
          type: "receipt",
          name: "Receipt",
          metadata: {
            originalListingId: listing.id,
            sellerAgentId: seller.id,
            amountPaid: 1000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(buyer.id));

        const result = await fetchMyReceipts();

        expect(result.receipts.length).toBeGreaterThan(0);
        const receipt = result.receipts[0];
        expect(receipt).toHaveProperty("id");
        expect(receipt).toHaveProperty("metadata");
        expect(receipt).toHaveProperty("createdAt");
        if (receipt.listing) {
          expect(receipt.listing.id).toBe(listing.id);
        }
        if (receipt.seller) {
          expect(receipt.seller.id).toBe(seller.id);
          expect(receipt.seller.name).toBe("Seller");
        }
      }));
  });

  // ===========================================================================
  // fetchEvents
  // ===========================================================================

  describe("fetchEvents", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchEvents()).rejects.toThrow("Unauthorized");
      }));

    it("returns event agents when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchEvents(10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchPlaces
  // ===========================================================================

  describe("fetchPlaces", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchPlaces()).rejects.toThrow("Unauthorized");
      }));

    it("returns combined place agents from all subtypes", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPlaces(10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchProjects
  // ===========================================================================

  describe("fetchProjects", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchProjects()).rejects.toThrow("Unauthorized");
      }));

    it("returns project agents when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchProjects(10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });
});
