import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestPost,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger } from "@/db/schema";

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

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 100, windowMs: 60000 },
    WALLET: { limit: 50, windowMs: 60000 },
    SETTINGS: { limit: 20, windowMs: 60000 },
  },
}));

vi.mock("@/lib/matrix-groups", () => ({
  inviteToGroupRoom: vi.fn().mockResolvedValue(undefined),
  removeFromGroupRoom: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  toggleFollowAgent,
  toggleJoinGroup,
  fetchJoinState,
  fetchFollowingIds,
  toggleHiddenContent,
  fetchHiddenContentPreferences,
} from "../social";

// =============================================================================
// Tests
// =============================================================================

describe("social interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // toggleFollowAgent
  // ---------------------------------------------------------------------------

  describe("toggleFollowAgent", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleFollowAgent("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a follow/connect ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleFollowAgent(target.id);

        expect(result).toEqual({
          success: true,
          message: "connect added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "follow"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(target.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("connect");
      }));

    it("toggles off an existing follow", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleFollowAgent(target.id);
        const result = await toggleFollowAgent(target.id);

        expect(result).toEqual({
          success: true,
          message: "connect removed",
          active: false,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "follow"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleJoinGroup
  // ---------------------------------------------------------------------------

  describe("toggleJoinGroup", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleJoinGroup("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error when group is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleJoinGroup("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Group not found");
      }));

    it("creates a membership ledger entry for a group", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleJoinGroup(group.id);

        expect(result).toEqual({
          success: true,
          message: "membership added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(group.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("membership");
      }));

    it("toggles off an existing membership", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleJoinGroup(group.id);
        const result = await toggleJoinGroup(group.id);

        expect(result).toEqual({
          success: true,
          message: "membership removed",
          active: false,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));

    it("accepts ring type parameter", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb, {
          metadata: { groupType: "ring" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleJoinGroup(ring.id, "ring");

        expect(result.success).toBe(true);
        expect(result.active).toBe(true);
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchJoinState
  // ---------------------------------------------------------------------------

  describe("fetchJoinState", () => {
    it("returns joined false when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const state = await fetchJoinState("any-group-id");

        expect(state).toEqual({ joined: false });
      }));

    it("returns joined true when user has active membership", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleJoinGroup(group.id);

        const state = await fetchJoinState(group.id);

        expect(state).toEqual({ joined: true });
      }));

    it("returns joined false after membership is toggled off", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleJoinGroup(group.id);
        await toggleJoinGroup(group.id);

        const state = await fetchJoinState(group.id);

        expect(state).toEqual({ joined: false });
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchFollowingIds
  // ---------------------------------------------------------------------------

  describe("fetchFollowingIds", () => {
    it("returns empty array when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchFollowingIds();

        expect(result).toEqual([]);
      }));

    it("returns IDs of followed agents", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target1 = await createTestAgent(txDb);
        const target2 = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleFollowAgent(target1.id);
        await toggleFollowAgent(target2.id);

        const result = await fetchFollowingIds();

        expect(result.length).toBe(2);
        expect(result).toContain(target1.id);
        expect(result).toContain(target2.id);
      }));

    it("excludes unfollowed agents", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleFollowAgent(target.id);
        await toggleFollowAgent(target.id); // unfollow

        const result = await fetchFollowingIds();

        expect(result).toEqual([]);
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleHiddenContent
  // ---------------------------------------------------------------------------

  describe("toggleHiddenContent", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleHiddenContent("any-id", "post", "post");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("hides a post", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleHiddenContent(post.id, "post", "post");

        expect(result.success).toBe(true);
        expect(result.active).toBe(true);
        expect(result.message).toContain("hide-post added");
      }));

    it("hides an author", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const author = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleHiddenContent(author.id, "person", "author");

        expect(result.success).toBe(true);
        expect(result.active).toBe(true);
        expect(result.message).toContain("hide-author added");
      }));

    it("toggles off a hidden post", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleHiddenContent(post.id, "post", "post");
        const result = await toggleHiddenContent(post.id, "post", "post");

        expect(result.success).toBe(true);
        expect(result.active).toBe(false);
        expect(result.message).toContain("hide-post removed");
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchHiddenContentPreferences
  // ---------------------------------------------------------------------------

  describe("fetchHiddenContentPreferences", () => {
    it("returns empty arrays when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const prefs = await fetchHiddenContentPreferences();

        expect(prefs).toEqual({
          hiddenPostIds: [],
          hiddenAuthorIds: [],
        });
      }));

    it("returns hidden post and author IDs", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const author = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleHiddenContent(post.id, "post", "post");
        await toggleHiddenContent(author.id, "person", "author");

        const prefs = await fetchHiddenContentPreferences();

        expect(prefs.hiddenPostIds).toContain(post.id);
        expect(prefs.hiddenAuthorIds).toContain(author.id);
      }));

    it("excludes unhidden content", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleHiddenContent(post.id, "post", "post");
        await toggleHiddenContent(post.id, "post", "post"); // unhide

        const prefs = await fetchHiddenContentPreferences();

        expect(prefs.hiddenPostIds).toEqual([]);
      }));
  });
});
