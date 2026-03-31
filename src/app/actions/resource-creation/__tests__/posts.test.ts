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

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 500, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/billing", () => ({
  hasEntitlement: vi.fn().mockResolvedValue(true),
  getActiveSubscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ai", () => ({
  embedResource: vi.fn().mockResolvedValue(undefined),
  scheduleEmbedding: vi.fn((fn: () => void) => fn()),
}));

vi.mock("@/lib/murmurations", () => ({
  syncMurmurationsProfilesForActor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/federation", () => ({
  getHostedNodeForOwner: vi.fn().mockResolvedValue(null),
  queueEntityExportEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/queries/agents", () => ({
  getAgent: vi.fn().mockResolvedValue({ name: "Test User", image: null }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { hasEntitlement } from "@/lib/billing";
import { rateLimit } from "@/lib/rate-limit";
import { createPostResource, createPostCommerceResource } from "../posts";

// =============================================================================
// Constants
// =============================================================================

const MAX_POST_CONTENT_LENGTH = 50000;

// =============================================================================
// Tests
// =============================================================================

describe("post creation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // createPostResource
  // ===========================================================================

  describe("createPostResource", () => {
    it("returns INVALID_INPUT when content is empty", () =>
      withTestTransaction(async () => {
        const result = await createPostResource({ content: "" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when content is whitespace only", () =>
      withTestTransaction(async () => {
        const result = await createPostResource({ content: "   " });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when content exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createPostResource({
          content: "x".repeat(MAX_POST_CONTENT_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("maximum length");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createPostResource({ content: "Hello world" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("creates a post when input is valid", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Hello world!",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));

    it("uses content as fallback title when no title provided", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Short content",
        });

        expect(result.success).toBe(true);
      }));

    it("returns FORBIDDEN when posting to a group without membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Hello group",
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("allows posting to a group when user is creator", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Hello group",
          groupId: group.id,
        });

        expect(result.success).toBe(true);
      }));

    it("sets visibility to private when scoped to groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Scoped post",
          scopedGroupIds: ["some-group-id"],
        });

        expect(result.success).toBe(true);
      }));

    it("sets visibility to locale when scoped to locales only", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Local post",
          scopedLocaleIds: ["locale-1"],
        });

        expect(result.success).toBe(true);
      }));

    it("creates a post with explicit title", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          title: "My Post Title",
          content: "My post content",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });

  // ===========================================================================
  // createPostCommerceResource
  // ===========================================================================

  describe("createPostCommerceResource", () => {
    it("returns INVALID_INPUT when content is empty", () =>
      withTestTransaction(async () => {
        const result = await createPostCommerceResource({ content: "" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when content exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createPostCommerceResource({
          content: "x".repeat(MAX_POST_CONTENT_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createPostCommerceResource({
          content: "Buy this!",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns FORBIDDEN when posting to group without membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostCommerceResource({
          content: "Group post",
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("returns RATE_LIMITED when rate limit is exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await createPostCommerceResource({
          content: "Post content",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("RATE_LIMITED");
      }));

    it("returns INVALID_INPUT when both creating and linking an offering", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostCommerceResource({
          content: "Post content",
          linkedOfferingId: "some-offering-id",
          createOffering: {
            title: "New offering",
            offeringType: "service",
          },
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("not both");
      }));

    it("creates a post without offering when no commerce data", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostCommerceResource({
          content: "Just a post",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));

    it("returns SUBSCRIPTION_REQUIRED for paid inline offering without seller tier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(hasEntitlement).mockResolvedValueOnce(false);

        const result = await createPostCommerceResource({
          content: "Selling something",
          createOffering: {
            title: "Paid offering",
            offeringType: "product",
            basePriceCents: 5000,
          },
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
      }));

    it("creates post with inline offering when valid", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostCommerceResource({
          content: "Check out my free offering",
          createOffering: {
            title: "Free Thing",
            offeringType: "give",
            basePriceCents: 0,
          },
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });
});
