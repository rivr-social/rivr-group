import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestListing,
  createTestResource,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents, ledger, resources } from "@/db/schema";

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

vi.mock("@/app/actions/settings", () => ({
  updateProfileAction: vi.fn().mockResolvedValue({ success: true }),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { updateProfileAction } from "@/app/actions/settings";
import {
  updateMyProfile,
  toggleSaveListing,
  createGalleryAction,
} from "../profile";

// =============================================================================
// Tests
// =============================================================================

describe("profile interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateProfileAction).mockResolvedValue({ success: true });
  });

  // ---------------------------------------------------------------------------
  // updateMyProfile
  // ---------------------------------------------------------------------------

  describe("updateMyProfile", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateMyProfile({
          name: "New Name",
          bio: "New bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("updates agent name and metadata in database", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb, {
          name: "Old Name",
          description: "Old bio",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "Updated Name",
          bio: "Updated bio text",
          skills: ["cooking", "gardening"],
          location: "Portland, OR",
        });

        expect(result).toEqual({
          success: true,
          message: "Profile updated.",
        });

        // Verify DB was updated
        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.skills).toEqual(["cooking", "gardening"]);
        expect(meta.location).toBe("Portland, OR");
        expect(meta.updatedVia).toBe("profile-page");
      }));

    it("returns error when updateProfileAction fails", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(updateProfileAction).mockResolvedValue({
          success: false,
          error: "Name is required.",
        });

        const result = await updateMyProfile({
          name: "   ",
          bio: "bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Name is required");
      }));

    it("returns generic error when updateProfileAction fails without message", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(updateProfileAction).mockResolvedValue({
          success: false,
        });

        const result = await updateMyProfile({
          name: "Name",
          bio: "bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Unable to update profile");
      }));

    it("trims and filters empty skills", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await updateMyProfile({
          name: "Name",
          bio: "bio",
          skills: ["  cooking  ", "", "  ", "gardening"],
        });

        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.skills).toEqual(["cooking", "gardening"]);
      }));

    it("handles location as empty string when not provided", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await updateMyProfile({
          name: "Name",
          bio: "bio",
          skills: [],
        });

        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.location).toBe("");
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleSaveListing
  // ---------------------------------------------------------------------------

  describe("toggleSaveListing", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleSaveListing("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a save ledger entry for a listing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const seller = await createTestAgent(txDb);
        const listing = await createTestListing(txDb, seller.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleSaveListing(listing.id);

        expect(result).toEqual({
          success: true,
          message: "save added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "share"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("save");
      }));

    it("toggles off a saved listing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const seller = await createTestAgent(txDb);
        const listing = await createTestListing(txDb, seller.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleSaveListing(listing.id);
        const result = await toggleSaveListing(listing.id);

        expect(result).toEqual({
          success: true,
          message: "save removed",
          active: false,
        });
      }));
  });

  // ---------------------------------------------------------------------------
  // createGalleryAction
  // ---------------------------------------------------------------------------

  describe("createGalleryAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createGalleryAction({ title: "My Gallery" });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error when title is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGalleryAction({ title: "   " });

        expect(result.success).toBe(false);
        expect(result.message).toContain("title is required");
      }));

    it("creates a gallery resource and ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGalleryAction({ title: "Summer Photos" });

        expect(result.success).toBe(true);
        expect(result.message).toContain("Gallery created");
        expect(result.resourceId).toBeTruthy();

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.type).toBe("post");
        expect(created.name).toBe("Summer Photos");
        expect(created.ownerId).toBe(user.id);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.postType).toBe("gallery");
        expect(meta.images).toEqual([]);

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "create"),
              eq(ledger.objectId, result.resourceId!)
            )
          );

        expect(entries.length).toBe(1);
        const ledgerMeta = entries[0].metadata as Record<string, unknown>;
        expect(ledgerMeta.postType).toBe("gallery");
      }));

    it("creates a gallery scoped to a group", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGalleryAction({
          title: "Group Photos",
          groupId: group.id,
        });

        expect(result.success).toBe(true);

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.tags).toContain(group.id);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.groupId).toBe(group.id);
      }));

    it("creates a gallery without group scope", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGalleryAction({ title: "Personal Gallery" });

        expect(result.success).toBe(true);

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.tags).toEqual([]);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.groupId).toBeNull();
      }));
  });
});
