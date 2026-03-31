import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestResource,
  createTestLedgerEntry,
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

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 500, windowMs: 60_000 },
    WALLET: { limit: 100, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/persona", () => ({
  getOperatingAgentId: vi.fn(),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { getOperatingAgentId } from "@/lib/persona";
import { rateLimit } from "@/lib/rate-limit";
import { postCommentAction, fetchCommentsAction } from "../comments";

// =============================================================================
// Constants
// =============================================================================

const MAX_COMMENT_CONTENT_LENGTH = 10000;

// =============================================================================
// Tests
// =============================================================================

describe("comment actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // postCommentAction
  // ===========================================================================

  describe("postCommentAction", () => {
    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(getOperatingAgentId).mockResolvedValue(null);

        const result = await postCommentAction("resource-id", "Hello");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns INVALID_INPUT when content is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);

        const result = await postCommentAction("resource-id", "   ");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("empty");
      }));

    it("returns INVALID_INPUT when content exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);
        const longContent = "x".repeat(MAX_COMMENT_CONTENT_LENGTH + 1);

        const result = await postCommentAction("resource-id", longContent);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("maximum length");
      }));

    it("returns RATE_LIMITED when rate limit is exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await postCommentAction("resource-id", "Hello");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("RATE_LIMITED");
      }));

    it("creates a comment ledger entry and returns success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);

        const result = await postCommentAction(resource.id, "Great post!");

        expect(result.success).toBe(true);
        expect(result.message).toBe("Comment posted.");
        expect(result.resourceId).toBeDefined();

        // Verify ledger entry was created
        const entries = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.verb, "comment"),
              eq(ledger.subjectId, user.id),
              eq(ledger.resourceId, resource.id),
            ),
          );
        expect(entries).toHaveLength(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.content).toBe("Great post!");
        expect(meta.parentCommentId).toBeNull();
      }));

    it("stores parentCommentId in metadata for reply comments", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);

        const parentId = "parent-comment-uuid";
        const result = await postCommentAction(resource.id, "Reply!", parentId);

        expect(result.success).toBe(true);

        const entries = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.verb, "comment"),
              eq(ledger.subjectId, user.id),
            ),
          );
        expect(entries).toHaveLength(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.parentCommentId).toBe(parentId);
      }));

    it("trims whitespace from comment content", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);
        vi.mocked(getOperatingAgentId).mockResolvedValue(user.id);

        const result = await postCommentAction(resource.id, "  trimmed  ");

        expect(result.success).toBe(true);

        const entries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.verb, "comment"));
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.content).toBe("trimmed");
      }));
  });

  // ===========================================================================
  // fetchCommentsAction
  // ===========================================================================

  describe("fetchCommentsAction", () => {
    it("returns an empty array when no comments exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);

        const result = await fetchCommentsAction(resource.id);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.comments).toEqual([]);
        }
      }));

    it("returns comments with author info for a resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, { name: "Commenter" });
        const resource = await createTestResource(db, user.id);

        // Insert a comment ledger entry
        await createTestLedgerEntry(db, user.id, {
          verb: "comment",
          objectId: resource.id,
          objectType: "resource",
          resourceId: resource.id,
          isActive: true,
          metadata: {
            content: "Test comment",
            parentCommentId: null,
          },
        });

        const result = await fetchCommentsAction(resource.id);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.comments).toHaveLength(1);
          expect(result.comments[0].content).toBe("Test comment");
          expect(result.comments[0].authorName).toBe("Commenter");
          expect(result.comments[0].authorId).toBe(user.id);
          expect(result.comments[0].parentCommentId).toBeNull();
        }
      }));

    it("returns gift metadata when comment is a gift", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);

        await createTestLedgerEntry(db, user.id, {
          verb: "comment",
          objectId: resource.id,
          objectType: "resource",
          resourceId: resource.id,
          isActive: true,
          metadata: {
            content: "Gift for you",
            parentCommentId: null,
            isGift: true,
            giftType: "voucher",
            giftMessage: "Enjoy!",
            voucherId: "voucher-123",
            voucherName: "Community Voucher",
          },
        });

        const result = await fetchCommentsAction(resource.id);

        expect(result.success).toBe(true);
        if (result.success) {
          const comment = result.comments[0];
          expect(comment.isGift).toBe(true);
          expect(comment.giftType).toBe("voucher");
          expect(comment.giftMessage).toBe("Enjoy!");
          expect(comment.voucherId).toBe("voucher-123");
          expect(comment.voucherName).toBe("Community Voucher");
        }
      }));

    it("excludes inactive comments", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id);

        // Active comment
        await createTestLedgerEntry(db, user.id, {
          verb: "comment",
          objectId: resource.id,
          objectType: "resource",
          resourceId: resource.id,
          isActive: true,
          metadata: { content: "Active", parentCommentId: null },
        });

        // Inactive comment
        await createTestLedgerEntry(db, user.id, {
          verb: "comment",
          objectId: resource.id,
          objectType: "resource",
          resourceId: resource.id,
          isActive: false,
          metadata: { content: "Deleted", parentCommentId: null },
        });

        const result = await fetchCommentsAction(resource.id);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.comments).toHaveLength(1);
          expect(result.comments[0].content).toBe("Active");
        }
      }));
  });
});
