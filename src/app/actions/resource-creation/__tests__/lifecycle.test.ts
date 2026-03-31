import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestPost,
  createOwnership,
  createMembership,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { resources, ledger } from "@/db/schema";

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
  getAgent: vi.fn().mockResolvedValue({ name: "Test Agent", image: null }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  updateResource,
  deleteResource,
  createBadgeResourceAction,
  createLiveClassAction,
  createDocumentResourceAction,
  createProjectResource,
} from "../lifecycle";

// =============================================================================
// Tests
// =============================================================================

describe("lifecycle actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // updateResource
  // ===========================================================================

  describe("updateResource", () => {
    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateResource({ resourceId: "some-id" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns INVALID_INPUT when resourceId is missing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateResource({ resourceId: "" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns RATE_LIMITED when rate limit is exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await updateResource({ resourceId: "some-id" });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("RATE_LIMITED");
      }));

    it("returns FORBIDDEN when user does not own the resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        const resource = await createTestPost(db, otherUser.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateResource({
          resourceId: resource.id,
          name: "Updated",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("updates resource name when user is the owner", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateResource({
          resourceId: resource.id,
          name: "Updated Title",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBe(resource.id);

        const [updated] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, resource.id));
        expect(updated.name).toBe("Updated Title");
      }));

    it("creates an update ledger entry", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await updateResource({
          resourceId: resource.id,
          description: "New description",
        });

        const entries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.objectId, resource.id));

        const updateEntry = entries.find((e) => e.verb === "update");
        expect(updateEntry).toBeDefined();
        expect(updateEntry?.subjectId).toBe(user.id);
      }));

    it("merges metadataPatch with existing metadata", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestResource(db, user.id, {
          metadata: { existing: "value", keep: "this" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateResource({
          resourceId: resource.id,
          metadataPatch: { newField: "added" },
        });

        expect(result.success).toBe(true);

        const [updated] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, resource.id));
        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.existing).toBe("value");
        expect(meta.keep).toBe("this");
        expect(meta.newField).toBe("added");
      }));
  });

  // ===========================================================================
  // deleteResource
  // ===========================================================================

  describe("deleteResource", () => {
    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await deleteResource("some-id");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns INVALID_INPUT when resourceId is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deleteResource("");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns FORBIDDEN when user does not own the resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        const resource = await createTestPost(db, otherUser.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deleteResource(resource.id);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("soft deletes resource (sets deletedAt)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deleteResource(resource.id);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Deleted");

        const [deleted] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, resource.id));
        expect(deleted.deletedAt).not.toBeNull();
      }));

    it("creates a delete ledger entry", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const resource = await createTestPost(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await deleteResource(resource.id);

        const entries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.objectId, resource.id));

        const deleteEntry = entries.find((e) => e.verb === "delete");
        expect(deleteEntry).toBeDefined();
      }));

    it("archives instead of deleting when receipt history exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const listing = await createTestResource(db, user.id, {
          type: "listing",
          metadata: { listingType: "product" },
        });

        // Create a receipt resource referencing this listing
        await createTestResource(db, user.id, {
          type: "receipt",
          metadata: { originalListingId: listing.id },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deleteResource(listing.id);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Archived");

        const [archived] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, listing.id));
        expect(archived.visibility).toBe("private");
        expect(archived.deletedAt).toBeNull();
        const meta = archived.metadata as Record<string, unknown>;
        expect(meta.status).toBe("archived");
      }));
  });

  // ===========================================================================
  // createBadgeResourceAction
  // ===========================================================================

  describe("createBadgeResourceAction", () => {
    it("returns INVALID_INPUT when required fields are missing", () =>
      withTestTransaction(async () => {
        const result = await createBadgeResourceAction({
          groupId: "",
          name: "Badge",
          description: "A badge",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createBadgeResourceAction({
          groupId: "group-id",
          name: "Badge",
          description: "A badge",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns FORBIDDEN when user lacks group access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBadgeResourceAction({
          groupId: group.id,
          name: "Badge",
          description: "A badge",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("creates a badge resource when user has group access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createBadgeResourceAction({
          groupId: group.id,
          name: "Expert Badge",
          description: "For experts",
          level: "expert",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });

  // ===========================================================================
  // createLiveClassAction
  // ===========================================================================

  describe("createLiveClassAction", () => {
    it("returns INVALID_INPUT when groupId is missing", () =>
      withTestTransaction(async () => {
        const result = await createLiveClassAction({
          groupId: "",
          badgeId: "badge-id",
          title: "Class",
          description: "A class",
          date: "2026-05-01",
          durationMinutes: 60,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when date is missing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createLiveClassAction({
          groupId: "group-id",
          badgeId: "badge-id",
          title: "Class",
          description: "A class",
          date: "",
          durationMinutes: 60,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createLiveClassAction({
          groupId: "group-id",
          badgeId: "badge-id",
          title: "Class",
          description: "A class",
          date: "2026-05-01",
          durationMinutes: 60,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("creates a live class with tasks when user has access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createLiveClassAction({
          groupId: group.id,
          badgeId: "badge-id",
          title: "Intro to Gardening",
          description: "Learn the basics",
          date: "2026-05-01",
          durationMinutes: 90,
          tasks: [
            { name: "Plant a seed", description: "Plant at least one seed" },
            { name: "Water the garden", required: true },
          ],
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });

  // ===========================================================================
  // createDocumentResourceAction
  // ===========================================================================

  describe("createDocumentResourceAction", () => {
    it("returns INVALID_INPUT when groupId is missing", () =>
      withTestTransaction(async () => {
        const result = await createDocumentResourceAction({
          groupId: "",
          title: "Doc",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when title is missing", () =>
      withTestTransaction(async () => {
        const result = await createDocumentResourceAction({
          groupId: "group-id",
          title: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createDocumentResourceAction({
          groupId: "group-id",
          title: "Doc",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("creates a document resource when user has group access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createDocumentResourceAction({
          groupId: group.id,
          title: "Meeting Notes",
          content: "Notes from the meeting...",
          description: "Weekly meeting notes",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });

  // ===========================================================================
  // createProjectResource
  // ===========================================================================

  describe("createProjectResource", () => {
    it("returns INVALID_INPUT when required fields are missing", () =>
      withTestTransaction(async () => {
        const result = await createProjectResource({
          title: "",
          description: "Project desc",
          category: "infrastructure",
          groupId: "group-id",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createProjectResource({
          title: "Project",
          description: "Description",
          category: "infrastructure",
          groupId: "group-id",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns FORBIDDEN when user lacks group write access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createProjectResource({
          title: "Project",
          description: "Description",
          category: "infrastructure",
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("creates a project with nested jobs when user has access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createProjectResource({
          title: "Community Garden",
          description: "Build a community garden",
          category: "infrastructure",
          groupId: group.id,
          jobs: [
            {
              title: "Prepare soil",
              description: "Prepare the garden beds",
              tasks: [{ name: "Buy soil", description: "Purchase garden soil" }],
            },
          ],
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));
  });
});
