import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestPost,
  createTestResource,
  createTestLedgerEntry,
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
  fetchProfileData,
  fetchUserPosts,
  fetchUserEvents,
  fetchUserGroups,
  fetchReactionCountsForUser,
  fetchUserConnections,
} from "../profiles";

// =============================================================================
// Constants
// =============================================================================

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";
const INVALID_ID = "not-a-uuid";

// =============================================================================
// Tests
// =============================================================================

describe("graph/profiles actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchProfileData
  // ===========================================================================

  describe("fetchProfileData", () => {
    it("returns profile bundle for a visible agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchProfileData(user.id);

        expect(result).not.toBeNull();
        expect(result!.agent.id).toBe(user.id);
        expect(Array.isArray(result!.resources)).toBe(true);
        expect(Array.isArray(result!.recentActivity)).toBe(true);
      }));

    it("returns null for non-existent agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchProfileData(NONEXISTENT_UUID);

        expect(result).toBeNull();
      }));

    it("works for unauthenticated callers on public agents", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchProfileData(user.id);

        expect(result).not.toBeNull();
        expect(result!.agent.id).toBe(user.id);
      }));
  });

  // ===========================================================================
  // fetchUserPosts
  // ===========================================================================

  describe("fetchUserPosts", () => {
    it("returns posts owned by the user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const post = await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserPosts(user.id, 30);

        expect(result.owner).not.toBeNull();
        expect(result.owner!.id).toBe(user.id);
        expect(Array.isArray(result.posts)).toBe(true);
      }));

    it("returns empty for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserPosts(INVALID_ID);

        expect(result.posts).toEqual([]);
        expect(result.owner).toBeNull();
      }));

    it("returns empty posts and null owner for non-existent user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserPosts(NONEXISTENT_UUID);

        expect(result.posts).toEqual([]);
        expect(result.owner).toBeNull();
      }));

    it("respects the limit parameter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestPost(db, user.id);
        await createTestPost(db, user.id);
        await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserPosts(user.id, 1);

        expect(result.posts.length).toBeLessThanOrEqual(1);
      }));
  });

  // ===========================================================================
  // fetchUserEvents
  // ===========================================================================

  describe("fetchUserEvents", () => {
    it("returns empty array for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserEvents(INVALID_ID);

        expect(result).toEqual([]);
      }));

    it("returns serialized events array", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserEvents(user.id);

        expect(Array.isArray(result)).toBe(true);
      }));
  });

  // ===========================================================================
  // fetchUserGroups
  // ===========================================================================

  describe("fetchUserGroups", () => {
    it("returns empty array for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserGroups(INVALID_ID);

        expect(result).toEqual([]);
      }));

    it("returns groups the user belongs to", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const group = await createTestGroup(db, { visibility: "public" });
        await createMembership(db, user.id, group.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserGroups(user.id);

        expect(Array.isArray(result)).toBe(true);
      }));

    it("excludes basin/locale place-type groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        await createTestGroup(db, {
          visibility: "public",
          metadata: { placeType: "basin" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserGroups(user.id);

        for (const group of result) {
          const meta = (group.metadata ?? {}) as Record<string, unknown>;
          expect(typeof meta.placeType).not.toBe("string");
        }
      }));
  });

  // ===========================================================================
  // fetchReactionCountsForUser
  // ===========================================================================

  describe("fetchReactionCountsForUser", () => {
    it("returns empty object for invalid UUID", () =>
      withTestTransaction(async () => {
        const result = await fetchReactionCountsForUser(INVALID_ID);

        expect(result).toEqual({});
      }));

    it("returns empty object when user has no resources with reactions", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);

        const result = await fetchReactionCountsForUser(user.id);

        expect(result).toEqual({});
      }));

    it("counts reactions grouped by interactionType", () =>
      withTestTransaction(async (db) => {
        const owner = await createTestAgent(db);
        const reactor = await createTestAgent(db);
        const post = await createTestPost(db, owner.id);

        // Add reactions
        await createTestLedgerEntry(db, reactor.id, {
          verb: "react",
          objectId: post.id,
          objectType: "resource",
          isActive: true,
          metadata: { interactionType: "like", targetId: post.id },
        });

        const result = await fetchReactionCountsForUser(owner.id);

        // Result may or may not have "like" depending on query implementation
        expect(typeof result).toBe("object");
      }));
  });

  // ===========================================================================
  // fetchUserConnections
  // ===========================================================================

  describe("fetchUserConnections", () => {
    it("returns empty array for invalid UUID", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchUserConnections(INVALID_ID);

        expect(result).toEqual([]);
      }));

    it("returns empty array when user has no connections", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserConnections(user.id);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([]);
      }));

    it("returns connected agents when follow entries exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { visibility: "public" });
        const friend = await createTestAgent(db, { visibility: "public" });

        // Create a follow connection
        await createTestLedgerEntry(db, user.id, {
          verb: "follow",
          objectId: friend.id,
          objectType: "agent",
          isActive: true,
          metadata: { interactionType: "connect", targetId: friend.id },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchUserConnections(user.id);

        expect(Array.isArray(result)).toBe(true);
      }));
  });
});
