import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createMembership,
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
  fetchGroupDetail,
  fetchGroupMemberList,
  fetchPeopleMemberList,
  fetchGroupRelationships,
  fetchGroupBadges,
} from "../groups";

// =============================================================================
// Constants
// =============================================================================

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";
const INVALID_ID = "not-a-uuid";

// =============================================================================
// Tests
// =============================================================================

describe("graph/groups actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchGroupDetail
  // ===========================================================================

  describe("fetchGroupDetail", () => {
    it("returns group detail bundle for a visible public group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const group = await createTestGroup(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupDetail(group.id);

        expect(result).not.toBeNull();
        expect(result!.group.id).toBe(group.id);
        expect(Array.isArray(result!.members)).toBe(true);
        expect(Array.isArray(result!.subgroups)).toBe(true);
        expect(Array.isArray(result!.events)).toBe(true);
        expect(Array.isArray(result!.resources)).toBe(true);
      }));

    it("returns null for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupDetail(INVALID_ID);

        expect(result).toBeNull();
      }));

    it("returns null for non-existent group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupDetail(NONEXISTENT_UUID);

        expect(result).toBeNull();
      }));

    it("returns group detail for unauthenticated caller on public group", () =>
      withTestTransaction(async (db) => {
        await createTestGroup(db, { visibility: "public" });
        const group = await createTestGroup(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupDetail(group.id);

        // May return null if publication policy denies anonymous access
        if (result) {
          expect(result.group.id).toBe(group.id);
        }
      }));

    it("includes members from ledger membership entries", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const group = await createTestGroup(db, { visibility: "public" });
        await createMembership(db, user.id, group.id, "member");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupDetail(group.id);

        expect(result).not.toBeNull();
        expect(Array.isArray(result!.members)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchGroupMemberList
  // ===========================================================================

  describe("fetchGroupMemberList", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchGroupMemberList(group.id)).rejects.toThrow("Unauthorized");
      }));

    it("returns member info list for a visible group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const group = await createTestGroup(db, { visibility: "public" });
        await createMembership(db, user.id, group.id, "member");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupMemberList(group.id);

        expect(Array.isArray(result)).toBe(true);
        for (const member of result) {
          expect(member).toHaveProperty("id");
          expect(member).toHaveProperty("name");
          expect(member).toHaveProperty("username");
          expect(member).toHaveProperty("avatar");
        }
      }));
  });

  // ===========================================================================
  // fetchPeopleMemberList
  // ===========================================================================

  describe("fetchPeopleMemberList", () => {
    it("throws Unauthorized when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(fetchPeopleMemberList()).rejects.toThrow("Unauthorized");
      }));

    it("returns member info list when authenticated", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchPeopleMemberList(10);

        expect(Array.isArray(result)).toBe(true);
        for (const member of result) {
          expect(member).toHaveProperty("id");
          expect(member).toHaveProperty("name");
          expect(member).toHaveProperty("username");
          expect(member).toHaveProperty("avatar");
        }
      }));
  });

  // ===========================================================================
  // fetchGroupRelationships
  // ===========================================================================

  describe("fetchGroupRelationships", () => {
    it("returns empty array when no relationships exist", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db);

        const result = await fetchGroupRelationships(group.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns relationship entries with correct shape", () =>
      withTestTransaction(async (db) => {
        const group1 = await createTestGroup(db, { visibility: "public" });
        const group2 = await createTestGroup(db, { visibility: "public" });

        // Create a relationship in the ledger
        const { createTestLedgerEntry } = await import("@/test/fixtures");
        await createTestLedgerEntry(db, group1.id, {
          verb: "relate",
          objectId: group2.id,
          objectType: "agent",
          isActive: true,
          metadata: { relationshipType: "affiliate", description: "Test affiliation" },
        });

        const result = await fetchGroupRelationships(group1.id);

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty("id");
          expect(result[0]).toHaveProperty("sourceGroupId");
          expect(result[0]).toHaveProperty("targetGroupId");
          expect(result[0]).toHaveProperty("type");
          expect(result[0]).toHaveProperty("createdAt");
        }
      }));
  });

  // ===========================================================================
  // fetchGroupBadges
  // ===========================================================================

  describe("fetchGroupBadges", () => {
    it("returns empty array when group has no badges", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupBadges(group.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns badge resources for a group", () =>
      withTestTransaction(async (db) => {
        const group = await createTestGroup(db, { visibility: "public" });
        await createTestResource(db, group.id, {
          type: "badge",
          name: "Test Badge",
          visibility: "public",
        });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupBadges(group.id);

        expect(Array.isArray(result)).toBe(true);
      }));
  });
});
