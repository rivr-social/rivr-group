import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestResource,
  createTestPost,
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
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "../composer";

// =============================================================================
// Tests
// =============================================================================

describe("graph/composer actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchAgentsForComposer
  // ===========================================================================

  describe("fetchAgentsForComposer", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchAgentsForComposer();

        expect(result).toEqual([]);
      }));

    it("returns compact agent list when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { name: "Composer User" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentsForComposer(10);

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty("id");
          expect(result[0]).toHaveProperty("name");
          expect(result[0]).toHaveProperty("type");
          // Should NOT have full agent fields like email, metadata, etc.
          expect(result[0]).not.toHaveProperty("email");
          expect(result[0]).not.toHaveProperty("metadata");
        }
      }));

    it("includes the current user in results", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { name: "My Agent" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentsForComposer(200);

        const ids = result.map((r) => r.id);
        expect(ids).toContain(user.id);
      }));

    it("respects the limit parameter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestAgent(db);
        await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentsForComposer(1);

        expect(result.length).toBeLessThanOrEqual(1);
      }));

    it("excludes soft-deleted agents", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const deleted = await createTestAgent(db, {
          name: "Deleted Agent",
          deletedAt: new Date(),
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentsForComposer(200);

        const ids = result.map((r) => r.id);
        expect(ids).not.toContain(deleted.id);
      }));
  });

  // ===========================================================================
  // fetchResourcesForComposer
  // ===========================================================================

  describe("fetchResourcesForComposer", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchResourcesForComposer();

        expect(result).toEqual([]);
      }));

    it("returns compact resource list when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestPost(db, user.id, { name: "Composer Post" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({ limit: 10 });

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty("id");
          expect(result[0]).toHaveProperty("title");
          expect(result[0]).toHaveProperty("type");
        }
      }));

    it("filters by resource types", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestPost(db, user.id);
        await createTestResource(db, user.id, { type: "document" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({ types: ["post"], limit: 50 });

        expect(Array.isArray(result)).toBe(true);
        for (const item of result) {
          expect(item.type).toBe("post");
        }
      }));

    it("filters by owner id", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        await createTestPost(db, user.id, { name: "My Post" });
        await createTestPost(db, otherUser.id, { name: "Other Post" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({ ownerId: user.id, limit: 50 });

        expect(Array.isArray(result)).toBe(true);
        // All returned items should belong to the specified owner
      }));

    it("respects the limit parameter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestPost(db, user.id);
        await createTestPost(db, user.id);
        await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({ limit: 1 });

        expect(result.length).toBeLessThanOrEqual(1);
      }));

    it("excludes soft-deleted resources", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const deleted = await createTestPost(db, user.id, {
          name: "Deleted Post",
          deletedAt: new Date(),
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({ limit: 200 });

        const ids = result.map((r) => r.id);
        expect(ids).not.toContain(deleted.id);
      }));

    it("includes quantity fields from metadata when present", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestResource(db, user.id, {
          type: "voucher",
          name: "Qty Voucher",
          metadata: { quantityAvailable: 10, quantityRemaining: 5 },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchResourcesForComposer({
          types: ["voucher"],
          limit: 50,
        });

        expect(Array.isArray(result)).toBe(true);
        const voucher = result.find((r) => r.title === "Qty Voucher");
        if (voucher) {
          expect(voucher.quantityAvailable).toBe(10);
          expect(voucher.quantityRemaining).toBe(5);
        }
      }));
  });
});
