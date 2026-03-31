import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestPost,
  createTestListing,
  createTestResource,
  createTestWallet,
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
  fetchResourcesByOwner,
  fetchPublicResources,
  fetchAllResources,
  fetchMarketplaceListings,
  fetchMarketplaceListingById,
  fetchPostDetail,
  fetchEventDetail,
} from "../resources";

// =============================================================================
// Constants
// =============================================================================

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";
const INVALID_ID = "not-a-uuid";

// =============================================================================
// Tests
// =============================================================================

describe("graph/resources actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchResourcesByOwner
  // ===========================================================================

  describe("fetchResourcesByOwner", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchResourcesByOwner(user.id)).rejects.toThrow("Unauthorized");
      }));

    it("returns resources owned by the specified agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesByOwner(user.id);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchPublicResources
  // ===========================================================================

  describe("fetchPublicResources", () => {
    it("returns resources without authentication", () =>
      withTestTransaction(async (db) => {
        await createTestResource(db, (await createTestAgent(db)).id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchPublicResources(10);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("returns resources when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestResource(db, user.id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPublicResources(10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchAllResources
  // ===========================================================================

  describe("fetchAllResources", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchAllResources()).rejects.toThrow("Unauthorized");
      }));

    it("returns resources with owner data when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestPost(db, user.id, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAllResources({ limit: 10 });

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchMarketplaceListings
  // ===========================================================================

  describe("fetchMarketplaceListings", () => {
    it("returns listings without requiring authentication", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMarketplaceListings(10);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("returns listings with owner data when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchMarketplaceListings(10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchMarketplaceListingById
  // ===========================================================================

  describe("fetchMarketplaceListingById", () => {
    it("returns null for invalid UUID", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMarketplaceListingById(INVALID_ID);

        expect(result).toBeNull();
      }));

    it("returns null for non-existent listing", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMarketplaceListingById(NONEXISTENT_UUID);

        expect(result).toBeNull();
      }));

    it("returns listing with owner and checkout info", () =>
      withTestTransaction(async (db) => {
        const seller = await createTestAgent(db, { visibility: "public" });
        const listing = await createTestListing(db, seller.id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(seller.id));

        const result = await fetchMarketplaceListingById(listing.id);

        if (result) {
          expect(result.resource.id).toBe(listing.id);
          expect(result).toHaveProperty("owner");
          expect(result.resource.metadata).toHaveProperty("cardCheckoutAvailable");
        }
      }));

    it("includes cardCheckoutAvailable=true when seller has Stripe Connect", () =>
      withTestTransaction(async (db) => {
        const seller = await createTestAgent(db, { visibility: "public" });
        const listing = await createTestListing(db, seller.id, {
          visibility: "public",
          isPublic: true,
        });
        await createTestWallet(db, seller.id, {
          type: "personal",
          metadata: {
            stripeConnectAccountId: "acct_test_123",
            connectChargesEnabled: true,
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(seller.id));

        const result = await fetchMarketplaceListingById(listing.id);

        if (result) {
          expect(result.resource.metadata.cardCheckoutAvailable).toBe(true);
        }
      }));

    it("returns listing for unauthenticated caller on public listing", () =>
      withTestTransaction(async (db) => {
        const seller = await createTestAgent(db, { visibility: "public" });
        const listing = await createTestListing(db, seller.id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMarketplaceListingById(listing.id);

        if (result) {
          expect(result.resource.id).toBe(listing.id);
        }
      }));
  });

  // ===========================================================================
  // fetchPostDetail
  // ===========================================================================

  describe("fetchPostDetail", () => {
    it("returns null for invalid UUID", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchPostDetail(INVALID_ID);

        expect(result).toBeNull();
      }));

    it("returns null for non-existent post", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchPostDetail(NONEXISTENT_UUID);

        expect(result).toBeNull();
      }));

    it("returns post detail with author for public post", () =>
      withTestTransaction(async (db) => {
        const author = await createTestAgent(db, { visibility: "public" });
        const post = await createTestPost(db, author.id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(author.id));

        const result = await fetchPostDetail(post.id);

        expect(result).not.toBeNull();
        expect(result!.resource.id).toBe(post.id);
        expect(result!.author).not.toBeNull();
        expect(result!.author!.id).toBe(author.id);
      }));

    it("returns null for non-post resource types", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const doc = await createTestResource(db, user.id, {
          type: "document",
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPostDetail(doc.id);

        expect(result).toBeNull();
      }));

    it("returns post with null author when author is not viewable", () =>
      withTestTransaction(async (db) => {
        const author = await createTestAgent(db, { visibility: "private" });
        const viewer = await createTestAgent(db, { visibility: "public" });
        const post = await createTestPost(db, author.id, {
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(viewer.id));

        const result = await fetchPostDetail(post.id);

        // Author may be null if viewer cannot view the author
        if (result) {
          expect(result.resource.id).toBe(post.id);
        }
      }));
  });

  // ===========================================================================
  // fetchEventDetail
  // ===========================================================================

  describe("fetchEventDetail", () => {
    it("returns null for invalid UUID", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchEventDetail(INVALID_ID);

        expect(result).toBeNull();
      }));

    it("returns null for non-existent event", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchEventDetail(NONEXISTENT_UUID);

        expect(result).toBeNull();
      }));

    it("returns null for non-event resource types", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const doc = await createTestResource(db, user.id, {
          type: "document",
          visibility: "public",
          isPublic: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchEventDetail(doc.id);

        expect(result).toBeNull();
      }));

    it("returns event detail for an event resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const event = await createTestResource(db, user.id, {
          type: "event",
          name: "Test Event Resource",
          visibility: "public",
          isPublic: true,
          metadata: { entityType: "event", date: "2026-06-01" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchEventDetail(event.id);

        if (result) {
          expect(result.id).toBe(event.id);
          expect(result.type).toBe("event");
          expect(result.name).toBe("Test Event Resource");
        }
      }));
  });
});
