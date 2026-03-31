import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
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

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  toggleLikeOnTarget,
  setReactionOnTarget,
  fetchReactionSummaries,
  toggleThankOnTarget,
} from "../reactions";

// =============================================================================
// Tests
// =============================================================================

describe("reaction interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // toggleLikeOnTarget
  // ---------------------------------------------------------------------------

  describe("toggleLikeOnTarget", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleLikeOnTarget("any-id", "post");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a like ledger entry when none exists", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleLikeOnTarget(post.id, "post");

        expect(result).toEqual({
          success: true,
          message: "like added",
          active: true,
          reactionType: "like",
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "react"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(post.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("like");
      }));

    it("toggles off an existing like (deactivates)", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleLikeOnTarget(post.id, "post");
        const result = await toggleLikeOnTarget(post.id, "post");

        expect(result).toEqual({
          success: true,
          message: "like removed",
          active: false,
          reactionType: null,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "react"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // setReactionOnTarget
  // ---------------------------------------------------------------------------

  describe("setReactionOnTarget", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await setReactionOnTarget("any-id", "post", "love");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a reaction entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setReactionOnTarget(post.id, "post", "love");

        expect(result.success).toBe(true);
        expect(result.message).toContain("love added");
        expect(result.active).toBe(true);
        expect(result.reactionType).toBe("love");
      }));

    it("replaces existing reaction with a new type", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setReactionOnTarget(post.id, "post", "like");
        const result = await setReactionOnTarget(post.id, "post", "love");

        expect(result.success).toBe(true);
        expect(result.message).toContain("love added");
        expect(result.reactionType).toBe("love");

        // Only one active reaction should exist
        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "react"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(1);
        const meta = activeEntries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("love");
      }));

    it("toggles off the same reaction type", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setReactionOnTarget(post.id, "post", "wow");
        const result = await setReactionOnTarget(post.id, "post", "wow");

        expect(result.success).toBe(true);
        expect(result.message).toContain("wow removed");
        expect(result.active).toBe(false);
        expect(result.reactionType).toBeNull();
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchReactionSummaries
  // ---------------------------------------------------------------------------

  describe("fetchReactionSummaries", () => {
    it("returns empty object for empty target IDs", async () => {
      const result = await fetchReactionSummaries([], "post");

      expect(result).toEqual({});
    });

    it("returns summaries with zero counts for targets with no reactions", () =>
      withTestTransaction(async (txDb) => {
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);

        const result = await fetchReactionSummaries([post.id], "post");

        expect(result[post.id]).toBeDefined();
        expect(result[post.id].totalCount).toBe(0);
        expect(result[post.id].currentUserReaction).toBeNull();
      }));

    it("returns reaction counts and current user reaction", () =>
      withTestTransaction(async (txDb) => {
        const user1 = await createTestAgent(txDb);
        const user2 = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        await setReactionOnTarget(post.id, "post", "like");

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user2.id));
        await setReactionOnTarget(post.id, "post", "love");

        // Fetch as user1
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        const result = await fetchReactionSummaries([post.id], "post");

        expect(result[post.id].totalCount).toBe(2);
        expect(result[post.id].counts.like).toBe(1);
        expect(result[post.id].counts.love).toBe(1);
        expect(result[post.id].currentUserReaction).toBe("like");
      }));

    it("returns summaries for multiple targets", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post1 = await createTestPost(txDb, poster.id);
        const post2 = await createTestPost(txDb, poster.id);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        await setReactionOnTarget(post1.id, "post", "like");

        const result = await fetchReactionSummaries([post1.id, post2.id], "post");

        expect(result[post1.id].totalCount).toBe(1);
        expect(result[post2.id].totalCount).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleThankOnTarget
  // ---------------------------------------------------------------------------

  describe("toggleThankOnTarget", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleThankOnTarget("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a thank ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleThankOnTarget(post.id, "post");

        expect(result.success).toBe(true);
        expect(result.message).toContain("thank added");
        expect(result.active).toBe(true);
      }));

    it("toggles off a thank reaction", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleThankOnTarget(post.id, "post");
        const result = await toggleThankOnTarget(post.id, "post");

        expect(result.success).toBe(true);
        expect(result.message).toContain("thank removed");
        expect(result.active).toBe(false);
      }));
  });
});
