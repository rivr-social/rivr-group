/**
 * Tests for create-resources server actions.
 *
 * Uses real database via withTestTransaction — every test runs inside a
 * transaction that rolls back, giving perfect isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createMembership, createTestSubscription } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { eq } from "drizzle-orm";
import { resources, ledger } from "@/db/schema";

// ---------------------------------------------------------------------------
// Mocks — framework & external services only
// ---------------------------------------------------------------------------

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
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
  RATE_LIMITS: {
    SOCIAL: { limit: 500, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/billing", () => ({
  getActiveSubscription: vi.fn().mockResolvedValue(null),
}));

import { auth } from "@/auth";
import { getActiveSubscription } from "@/lib/billing";
import {
  createPostResource,
  createEventResource,
  createProjectResource,
  createGroupResource,
  createMarketplaceListingResource,
} from "../create-resources";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("create-resources actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // createPostResource
  // =========================================================================

  describe("createPostResource", () => {
    it("creates a post resource and ledger entry", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          title: "My First Post",
          content: "Hello world from the community.",
          postType: "social",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        // Verify resource row
        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource).toBeDefined();
        expect(resource.name).toBe("My First Post");
        expect(resource.type).toBe("post");
        expect(resource.content).toBe("Hello world from the community.");
        expect(resource.ownerId).toBe(user.id);

        // Verify ledger entry
        const [entry] = await db
          .select()
          .from(ledger)
          .where(eq(ledger.resourceId, result.resourceId!));

        expect(entry).toBeDefined();
        expect(entry.verb).toBe("create");
        expect(entry.subjectId).toBe(user.id);
        expect(entry.objectId).toBe(result.resourceId);
        expect(entry.objectType).toBe("resource");
      }));

    it("uses content as fallback title when title is missing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Content used as a fallback title when no explicit title is provided.",
        });

        expect(result.success).toBe(true);

        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource.name).toBe(
          "Content used as a fallback title when no explicit title is provided."
        );
      }));

    it("returns UNAUTHENTICATED when not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createPostResource({
          title: "Should Not Save",
          content: "No session.",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns INVALID_INPUT when content is empty", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("11111111-1111-4111-8111-111111111111")
        );

        const result = await createPostResource({
          title: "Has title",
          content: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("tags post with localeId and groupId scope tags", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const localeId = "boulder-locale";
        const result = await createPostResource({
          content: "Scoped post",
          localeId,
          groupId: group.id,
        });

        expect(result.success).toBe(true);

        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource.tags).toContain(localeId);
        expect(resource.tags).toContain(group.id);
      }));

    it("returns FORBIDDEN when user lacks group write access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: otherUser.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Trying to post in someone else's group",
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("allows group member to post in a group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const owner = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: owner.id },
        });
        // Create membership for user in the group
        await createMembership(db, user.id, group.id, "member");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPostResource({
          content: "Member posting in group",
          groupId: group.id,
        });

        expect(result.success).toBe(true);
      }));
  });

  // =========================================================================
  // createEventResource
  // =========================================================================

  describe("createEventResource", () => {
    const validEventInput = {
      title: "Neighborhood Cleanup",
      description: "Join us to clean local parks.",
      date: "2026-04-10",
      time: "10:30",
      location: "Main Square",
      eventType: "in-person" as const,
      price: 0,
    };

    it("creates an event resource and ledger entry", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource(validEventInput);

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource.name).toBe("Neighborhood Cleanup");
        expect(resource.type).toBe("event");
        expect(resource.ownerId).toBe(user.id);
        const meta = resource.metadata as Record<string, unknown>;
        expect(meta.date).toBe("2026-04-10");
        expect(meta.time).toBe("10:30");
        expect(meta.eventType).toBe("in-person");
      }));

    it("returns INVALID_INPUT when required fields are missing", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("11111111-1111-4111-8111-111111111111")
        );

        const result = await createEventResource({
          title: "",
          description: "",
          date: "",
          time: "",
          location: "",
          eventType: "in-person",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createEventResource(validEventInput);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns SUBSCRIPTION_REQUIRED for paid events without active subscription", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getActiveSubscription).mockResolvedValue(null);

        const result = await createEventResource({
          ...validEventInput,
          price: 25,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
      }));

    it("allows paid events with an active subscription", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(getActiveSubscription).mockResolvedValue({
          id: "sub-1",
          status: "active",
        } as ReturnType<typeof getActiveSubscription> extends Promise<infer T> ? T : never);

        const result = await createEventResource({
          ...validEventInput,
          price: 25,
        });

        expect(result.success).toBe(true);
      }));
  });

  // =========================================================================
  // createProjectResource
  // =========================================================================

  describe("createProjectResource", () => {
    it("creates a project with jobs and tasks", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createProjectResource({
          title: "Community Garden",
          description: "Build a new garden space.",
          category: "environment",
          groupId: group.id,
          jobs: [
            {
              title: "Site Preparation",
              description: "Clear and prepare the land",
              tasks: [
                { name: "Remove debris", description: "Clear all debris" },
                { name: "Level ground", description: "Level the ground" },
              ],
            },
          ],
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        // Verify project resource
        const [project] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));
        expect(project.name).toBe("Community Garden");
        expect(project.type).toBe("project");

        // Verify job was created
        const jobs = await db
          .select()
          .from(resources)
          .where(eq(resources.type, "job"));
        expect(jobs.length).toBeGreaterThanOrEqual(1);
        const job = jobs.find((j) => j.name === "Site Preparation");
        expect(job).toBeDefined();

        // Verify tasks were created
        const tasks = await db
          .select()
          .from(resources)
          .where(eq(resources.type, "task"));
        expect(tasks.length).toBeGreaterThanOrEqual(2);
        const taskNames = tasks.map((t) => t.name);
        expect(taskNames).toContain("Remove debris");
        expect(taskNames).toContain("Level ground");

        // Verify ledger entries were created for project, job, and tasks
        const ledgerEntries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.subjectId, user.id));
        const createEntries = ledgerEntries.filter((e) => e.verb === "create");
        // 1 project + 1 job + 2 tasks = 4 create entries
        expect(createEntries.length).toBeGreaterThanOrEqual(4);
      }));

    it("returns INVALID_INPUT when required fields are missing", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("11111111-1111-4111-8111-111111111111")
        );

        const result = await createProjectResource({
          title: "",
          description: "",
          category: "",
          groupId: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns FORBIDDEN when user lacks group write access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: otherUser.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createProjectResource({
          title: "Unauthorized Project",
          description: "Should not create.",
          category: "test",
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));
  });

  // =========================================================================
  // createGroupResource
  // =========================================================================

  describe("createGroupResource", () => {
    it("creates a group (agent row), creator ledger entry, and admin membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          name: "River Friends",
          description: "Local watershed volunteers.",
          groupType: "community",
          chapter: "Boulder",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        // Verify the group agent was created (it's in agents table, not resources)
        const { agents } = await import("@/db/schema");
        const [group] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));

        expect(group).toBeDefined();
        expect(group.name).toBe("River Friends");
        expect(group.type).toBe("organization");
        const meta = group.metadata as Record<string, unknown>;
        expect(meta.groupType).toBe("community");
        expect(meta.chapter).toBe("Boulder");
        expect(meta.creatorId).toBe(user.id);

        // Verify creator ledger entry
        const entries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.objectId, result.resourceId!));

        const createEntry = entries.find((entry) => entry.verb === "create");
        const membershipEntry = entries.find((entry) => entry.verb === "belong");

        expect(createEntry).toBeDefined();
        expect(createEntry?.subjectId).toBe(user.id);
        expect(createEntry?.objectType).toBe("agent");

        expect(membershipEntry).toBeDefined();
        expect(membershipEntry?.subjectId).toBe(user.id);
        expect(membershipEntry?.role).toBe("admin");
        expect(membershipEntry?.isActive).toBe(true);
      }));

    it.each([
      {
        label: "missing name",
        payload: { name: "", description: "Desc", groupType: "community", chapter: "Boulder" },
      },
      {
        label: "missing description",
        payload: { name: "Group", description: "", groupType: "community", chapter: "Boulder" },
      },
      {
        label: "missing group type",
        payload: { name: "Group", description: "Desc", groupType: "", chapter: "Boulder" },
      },
      {
        label: "missing chapter",
        payload: { name: "Group", description: "Desc", groupType: "community", chapter: "" },
      },
    ])("returns INVALID_INPUT for $label", ({ payload }) =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("11111111-1111-4111-8111-111111111111")
        );

        const result = await createGroupResource(payload);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createGroupResource({
          name: "No Auth Group",
          description: "Should fail.",
          groupType: "community",
          chapter: "Boulder",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("creates a subgroup under a parent group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const parentGroup = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          name: "Sub Committee",
          description: "A working subgroup.",
          groupType: "committee",
          chapter: "Boulder",
          parentGroupId: parentGroup.id,
        });

        expect(result.success).toBe(true);

        const { agents } = await import("@/db/schema");
        const [subgroup] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));

        expect(subgroup.parentId).toBe(parentGroup.id);
        expect(subgroup.depth).toBe(1);
        expect(subgroup.pathIds).toContain(parentGroup.id);
      }));
  });

  // =========================================================================
  // createMarketplaceListingResource
  // =========================================================================

  describe("createMarketplaceListingResource", () => {
    it("creates a product listing as a resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMarketplaceListingResource({
          listingType: "product",
          title: "Handmade Soap",
          description: "Organic lavender soap.",
          price: 8.5,
          category: "crafts",
          condition: "new",
          location: "Boulder, CO",
          tags: ["organic", "handmade"],
          chapterTags: ["boulder"],
          images: [],
        });

        expect(result.success).toBe(true);

        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource.name).toBe("Handmade Soap");
        expect(resource.type).toBe("resource"); // product -> "resource" type
        const meta = resource.metadata as Record<string, unknown>;
        expect(meta.listingType).toBe("product");
        expect(meta.price).toBe(8.5);
      }));

    it("creates a service listing as a skill resource", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMarketplaceListingResource({
          listingType: "service",
          title: "Guitar Lessons",
          description: "1-hour guitar lesson for beginners.",
          price: 40,
          category: "music",
          location: "Online",
          tags: ["music", "lessons"],
          chapterTags: [],
          images: [],
        });

        expect(result.success).toBe(true);

        const [resource] = await db
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(resource.type).toBe("skill"); // service -> "skill" type
      }));

    it("returns INVALID_INPUT for negative price", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("11111111-1111-4111-8111-111111111111")
        );

        const result = await createMarketplaceListingResource({
          listingType: "product",
          title: "Invalid Product",
          description: "Has negative price.",
          price: -5,
          category: "test",
          location: "Nowhere",
          tags: [],
          chapterTags: [],
          images: [],
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));
  });
});
