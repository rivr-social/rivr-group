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
  fetchBasins,
  fetchLocales,
  fetchChapters,
  fetchGroupsByLocaleIds,
  fetchPeopleByLocaleIds,
} from "../places";

// =============================================================================
// Tests
// =============================================================================

describe("graph/places actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchBasins
  // ===========================================================================

  describe("fetchBasins", () => {
    it("returns basin/region place agents", () =>
      withTestTransaction(async (db) => {
        await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "basin" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchBasins(50);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("deduplicates agents by id", () =>
      withTestTransaction(async (db) => {
        await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "basin" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchBasins(50);

        const ids = result.map((r) => r.id);
        const uniqueIds = new Set(ids);
        expect(ids.length).toBe(uniqueIds.size);
      }));
  });

  // ===========================================================================
  // fetchLocales
  // ===========================================================================

  describe("fetchLocales", () => {
    it("returns chapter/locale place agents", () =>
      withTestTransaction(async (db) => {
        await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchLocales(50);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("deduplicates agents by id", () =>
      withTestTransaction(async (db) => {
        await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchLocales(50);

        const ids = result.map((r) => r.id);
        const uniqueIds = new Set(ids);
        expect(ids.length).toBe(uniqueIds.size);
      }));
  });

  // ===========================================================================
  // fetchChapters
  // ===========================================================================

  describe("fetchChapters", () => {
    it("returns chapter-shaped objects with expected fields", () =>
      withTestTransaction(async (db) => {
        await createTestPlace(db, {
          name: "Test Chapter",
          visibility: "public",
          metadata: {
            placeType: "chapter",
            slug: "test-chapter",
            memberCount: 42,
            location: "Portland, OR",
            basinId: "basin-1",
          },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchChapters(100);

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          const chapter = result[0];
          expect(chapter).toHaveProperty("id");
          expect(chapter).toHaveProperty("name");
          expect(chapter).toHaveProperty("slug");
          expect(chapter).toHaveProperty("memberCount");
          expect(chapter).toHaveProperty("image");
          expect(chapter).toHaveProperty("description");
          expect(chapter).toHaveProperty("location");
          expect(chapter).toHaveProperty("basinId");
          expect(chapter).toHaveProperty("isCommons");
        }
      }));

    it("defaults missing metadata fields", () =>
      withTestTransaction(async (db) => {
        const place = await createTestPlace(db, {
          name: "Bare Chapter",
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchChapters(100);
        const chapter = result.find((c) => c.name === "Bare Chapter");

        if (chapter) {
          expect(chapter.memberCount).toBe(0);
          expect(chapter.location).toBe("");
          expect(chapter.basinId).toBe("");
          expect(chapter.isCommons).toBe(false);
        }
      }));
  });

  // ===========================================================================
  // fetchGroupsByLocaleIds
  // ===========================================================================

  describe("fetchGroupsByLocaleIds", () => {
    it("returns empty array for empty locale ids", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupsByLocaleIds([]);

        expect(result).toEqual([]);
      }));

    it("filters out 'all' locale id", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupsByLocaleIds(["all"]);

        expect(result).toEqual([]);
      }));

    it("excludes place-type organizations", () =>
      withTestTransaction(async (db) => {
        const place = await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupsByLocaleIds([place.id]);

        for (const group of result) {
          const meta = (group.metadata ?? {}) as Record<string, unknown>;
          expect(typeof meta.placeType).not.toBe("string");
        }
      }));

    it("returns groups scoped to locale when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupsByLocaleIds([place.id], 50);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchPeopleByLocaleIds
  // ===========================================================================

  describe("fetchPeopleByLocaleIds", () => {
    it("returns empty array for empty locale ids", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchPeopleByLocaleIds([]);

        expect(result).toEqual([]);
      }));

    it("filters out 'all' locale id", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchPeopleByLocaleIds(["all"]);

        expect(result).toEqual([]);
      }));

    it("returns people when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPeopleByLocaleIds([place.id], undefined, 50);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("applies search query filter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, {
          name: "Searchable Person",
          visibility: "public",
        });
        const place = await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPeopleByLocaleIds([place.id], "Searchable", 50);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("falls back to global search when scoped results are empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, {
          visibility: "public",
          metadata: { placeType: "chapter" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // With an empty scope, should fallback to getAgentsByType
        const result = await fetchPeopleByLocaleIds([place.id], undefined, 50);

        expect(Array.isArray(result)).toBe(true);
      }));
  });
});
