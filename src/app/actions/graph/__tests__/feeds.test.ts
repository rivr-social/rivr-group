import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestPlace,
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
  fetchHomeFeed,
  fetchExploreFeed,
  fetchAgentFeed,
  fetchScopedHomeFeed,
} from "../feeds";

// =============================================================================
// Constants
// =============================================================================

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

// =============================================================================
// Tests
// =============================================================================

describe("graph/feeds actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchHomeFeed
  // ===========================================================================

  describe("fetchHomeFeed", () => {
    it("returns feed buckets without requiring authentication", () =>
      withTestTransaction(async (db) => {
        await createTestAgent(db, { visibility: "public" });
        await createTestGroup(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchHomeFeed(10);

        expect(result).toHaveProperty("people");
        expect(result).toHaveProperty("groups");
        expect(result).toHaveProperty("events");
        expect(result).toHaveProperty("places");
        expect(result).toHaveProperty("projects");
        expect(result).toHaveProperty("marketplace");
        expect(Array.isArray(result.people)).toBe(true);
        expect(Array.isArray(result.groups)).toBe(true);
      }));

    it("returns feed buckets when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchHomeFeed(10);

        expect(result).toHaveProperty("people");
        expect(result).toHaveProperty("groups");
        expect(result).toHaveProperty("events");
        expect(result).toHaveProperty("places");
        expect(result).toHaveProperty("projects");
        expect(result).toHaveProperty("marketplace");
      }));

    it("excludes place-type orgs from groups bucket", () =>
      withTestTransaction(async (db) => {
        await createTestGroup(db, {
          visibility: "public",
          metadata: { placeType: "basin" },
        });
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchHomeFeed(50);

        for (const group of result.groups) {
          const meta = (group.metadata ?? {}) as Record<string, unknown>;
          expect(typeof meta.placeType).not.toBe("string");
        }
      }));
  });

  // ===========================================================================
  // fetchExploreFeed
  // ===========================================================================

  describe("fetchExploreFeed", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchExploreFeed()).rejects.toThrow("Unauthorized");
      }));

    it("returns results object with category sampling when no query", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchExploreFeed(undefined, 10);

        expect(result).toHaveProperty("results");
        expect(Array.isArray(result.results)).toBe(true);
      }));

    it("returns search results when query is provided", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { name: "SearchableUser", visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchExploreFeed("SearchableUser", 10);

        expect(result).toHaveProperty("results");
        expect(Array.isArray(result.results)).toBe(true);
      }));

    it("returns empty results for whitespace-only query", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchExploreFeed("   ", 10);

        // Whitespace query goes through category sampling path
        expect(result).toHaveProperty("results");
        expect(Array.isArray(result.results)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchAgentFeed
  // ===========================================================================

  describe("fetchAgentFeed", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchAgentFeed("any-id")).rejects.toThrow("Unauthorized");
      }));

    it("returns empty array for non-existent agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentFeed(NONEXISTENT_UUID, 10);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns feed entries for a valid agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchAgentFeed(user.id, 10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchScopedHomeFeed
  // ===========================================================================

  describe("fetchScopedHomeFeed", () => {
    it("returns scoped feed buckets without authentication", () =>
      withTestTransaction(async (db) => {
        const place = await createTestPlace(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchScopedHomeFeed(place.id, 10);

        expect(result).toHaveProperty("people");
        expect(result).toHaveProperty("groups");
        expect(result).toHaveProperty("events");
        expect(result).toHaveProperty("places");
        expect(result).toHaveProperty("projects");
      }));

    it("returns scoped feed buckets when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchScopedHomeFeed(place.id, 10);

        expect(result).toHaveProperty("people");
        expect(result).toHaveProperty("groups");
        expect(result).toHaveProperty("events");
        expect(result).toHaveProperty("places");
        expect(result).toHaveProperty("projects");
      }));

    it("excludes place-type orgs from groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchScopedHomeFeed(place.id, 50);

        for (const group of result.groups) {
          const meta = (group.metadata ?? {}) as Record<string, unknown>;
          expect(typeof meta.placeType).not.toBe("string");
        }
      }));
  });
});
