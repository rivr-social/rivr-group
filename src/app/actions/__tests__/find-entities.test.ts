import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

// =============================================================================
// Mocks — real DB via test infra, auth + next framework mocked
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
import { findExistingEntitiesByNames } from "../find-entities";

// =============================================================================
// Tests
// =============================================================================

describe("findExistingEntitiesByNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  it("throws 'Unauthorized' when user is not authenticated", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(findExistingEntitiesByNames(["Alpha"])).rejects.toThrow(
        "Unauthorized"
      );
    }));

  it("throws 'Unauthorized' when session has no user id", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue({ user: {} } as ReturnType<typeof mockAuthSession>);

      await expect(findExistingEntitiesByNames(["Alpha"])).rejects.toThrow(
        "Unauthorized"
      );
    }));

  // ---------------------------------------------------------------------------
  // Empty input
  // ---------------------------------------------------------------------------

  it("returns empty Map when names array is empty", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames([]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    }));

  // ---------------------------------------------------------------------------
  // Single name found (agent)
  // ---------------------------------------------------------------------------

  it("returns map with lowercase key and isExisting flag for a single agent match", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const target = await createTestAgent(db, { name: "Alpine Ventures" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Alpine Ventures"]);

      expect(result.size).toBe(1);
      expect(result.has("alpine ventures")).toBe(true);

      const entry = result.get("alpine ventures")!;
      expect(entry.id).toBe(target.id);
      expect(entry.name).toBe("Alpine Ventures");
      expect(entry.targetTable).toBe("agents");
      expect(entry.isExisting).toBe(true);
    }));

  // ---------------------------------------------------------------------------
  // Multiple names
  // ---------------------------------------------------------------------------

  it("returns multiple entries when multiple names are found", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const alpha = await createTestAgent(db, { name: "Alpha Corp" });
      const beta = await createTestAgent(db, { name: "Beta Inc" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Alpha Corp", "Beta Inc"]);

      expect(result.size).toBe(2);
      expect(result.has("alpha corp")).toBe(true);
      expect(result.has("beta inc")).toBe(true);
      expect(result.get("alpha corp")!.id).toBe(alpha.id);
      expect(result.get("beta inc")!.id).toBe(beta.id);
    }));

  // ---------------------------------------------------------------------------
  // Exact match preferred over partial
  // ---------------------------------------------------------------------------

  it("prefers exact match over partial match when both exist", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      // Create a partial match first, then the exact match
      await createTestAgent(db, { name: "Alpha Industries" });
      const exact = await createTestAgent(db, { name: "Alpha" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Alpha"]);

      expect(result.size).toBe(1);
      const entry = result.get("alpha")!;
      expect(entry.id).toBe(exact.id);
      expect(entry.name).toBe("Alpha");
    }));

  // ---------------------------------------------------------------------------
  // No match
  // ---------------------------------------------------------------------------

  it("does not include key in map when no match is found", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["NonExistentEntityXYZ123"]);

      expect(result.size).toBe(0);
      expect(result.has("nonexistententityxyz123")).toBe(false);
    }));

  // ---------------------------------------------------------------------------
  // Partial match (ILIKE contains)
  // ---------------------------------------------------------------------------

  it("finds agent via partial ILIKE match", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const target = await createTestGroup(db, { name: "Community Garden Club" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Garden Club"]);

      expect(result.size).toBe(1);
      const entry = result.get("garden club")!;
      expect(entry.id).toBe(target.id);
      expect(entry.targetTable).toBe("agents");
    }));

  // ---------------------------------------------------------------------------
  // Resource fallback
  // ---------------------------------------------------------------------------

  it("falls back to resources when no agent matches", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const resource = await createTestResource(db, user.id, {
        name: "Unique Resource Item",
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Unique Resource Item"]);

      expect(result.size).toBe(1);
      const entry = result.get("unique resource item")!;
      expect(entry.id).toBe(resource.id);
      expect(entry.targetTable).toBe("resources");
      expect(entry.isExisting).toBe(true);
    }));

  // ---------------------------------------------------------------------------
  // Resource exact match preference
  // ---------------------------------------------------------------------------

  it("prefers exact resource match over partial when falling back", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      await createTestResource(db, user.id, { name: "Widget Pro Max" });
      const exact = await createTestResource(db, user.id, { name: "Widget" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["Widget"]);

      expect(result.size).toBe(1);
      const entry = result.get("widget")!;
      expect(entry.id).toBe(exact.id);
      expect(entry.targetTable).toBe("resources");
    }));

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  it("matches case-insensitively via ILIKE", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const target = await createTestAgent(db, { name: "CamelCase Entity" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames(["camelcase entity"]);

      expect(result.size).toBe(1);
      expect(result.get("camelcase entity")!.id).toBe(target.id);
    }));

  // ---------------------------------------------------------------------------
  // Mixed found and not-found
  // ---------------------------------------------------------------------------

  it("returns only matched names, skipping unmatched", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const found = await createTestAgent(db, { name: "Existing Entity ABC" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await findExistingEntitiesByNames([
        "Existing Entity ABC",
        "DoesNotExist999",
      ]);

      expect(result.size).toBe(1);
      expect(result.has("existing entity abc")).toBe(true);
      expect(result.get("existing entity abc")!.id).toBe(found.id);
      expect(result.has("doesnotexist999")).toBe(false);
    }));
});
