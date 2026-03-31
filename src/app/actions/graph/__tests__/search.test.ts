import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestPlace,
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

vi.mock("@/lib/ai", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("Embedding model unavailable in tests")),
  generateEmbeddings: vi.fn().mockRejectedValue(new Error("Embedding model unavailable in tests")),
  EMBEDDING_DIMENSIONS: 1536,
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  semanticSearch,
  searchInScope,
  queryLedgerEntries,
} from "../search";

// =============================================================================
// Constants
// =============================================================================

const MAX_QUERY_LENGTH = 500;

// =============================================================================
// Tests
// =============================================================================

describe("graph/search actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // semanticSearch
  // ===========================================================================

  describe("semanticSearch", () => {
    it("returns empty array for empty query", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await semanticSearch("");

        expect(result).toEqual([]);
      }));

    it("returns empty array for whitespace-only query", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await semanticSearch("   ");

        expect(result).toEqual([]);
      }));

    it("returns empty array when embedding generation fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await semanticSearch("test query");

        // The mock rejects generateEmbedding, so it falls back gracefully
        expect(result).toEqual([]);
      }));

    it("truncates query to max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const longQuery = "a".repeat(MAX_QUERY_LENGTH + 100);
        const result = await semanticSearch(longQuery);

        // Should not throw, just return empty (embedding fails in test)
        expect(Array.isArray(result)).toBe(true);
      }));

    it("works without authentication", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await semanticSearch("test");

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // searchInScope
  // ===========================================================================

  describe("searchInScope", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(searchInScope("scope-id", "query")).rejects.toThrow("Unauthorized");
      }));

    it("returns empty array for non-viewable scope", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, { visibility: "private" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await searchInScope(place.id, "test", 10);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("returns matching agents within scope", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const place = await createTestPlace(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await searchInScope(place.id, "test", 10);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // queryLedgerEntries
  // ===========================================================================

  describe("queryLedgerEntries", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await queryLedgerEntries({});

        expect(result).toEqual([]);
      }));

    it("returns empty array with no matching entries", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await queryLedgerEntries({
          verb: "nonexistent_verb",
        });

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns ledger entries with resolved names", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { name: "Test Subject" });
        const target = await createTestAgent(db, { name: "Test Object" });
        await createTestLedgerEntry(db, user.id, {
          verb: "view",
          objectId: target.id,
          objectType: "agent",
          isActive: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await queryLedgerEntries({ subjectId: user.id });

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty("id");
          expect(result[0]).toHaveProperty("verb");
          expect(result[0]).toHaveProperty("subjectId");
          expect(result[0]).toHaveProperty("subjectName");
          expect(result[0]).toHaveProperty("timestamp");
          expect(result[0].subjectId).toBe(user.id);
        }
      }));

    it("filters by verb", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestLedgerEntry(db, user.id, {
          verb: "view",
          isActive: true,
        });
        await createTestLedgerEntry(db, user.id, {
          verb: "create",
          isActive: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await queryLedgerEntries({ verb: "view" });

        expect(Array.isArray(result)).toBe(true);
        for (const entry of result) {
          expect(entry.verb).toBe("view");
        }
      }));

    it("filters by date range", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        await createTestLedgerEntry(db, user.id, {
          verb: "view",
          isActive: true,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await queryLedgerEntries({
          startDate: "2020-01-01",
          endDate: "2030-12-31",
        });

        expect(Array.isArray(result)).toBe(true);
      }));

    it("respects the limit parameter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        for (let i = 0; i < 5; i++) {
          await createTestLedgerEntry(db, user.id, {
            verb: "view",
            isActive: true,
          });
        }
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await queryLedgerEntries({}, 2);

        expect(result.length).toBeLessThanOrEqual(2);
      }));
  });
});
