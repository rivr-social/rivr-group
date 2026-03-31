import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup } from "@/test/fixtures";
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

vi.mock("@/app/actions/group-admin", () => ({
  isGroupAdmin: vi.fn().mockResolvedValue(false),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import {
  fetchGroupPressSourcesAction,
  updateGroupPressSourcesAction,
  fetchGroupPressFeedAction,
} from "../press";

// =============================================================================
// Constants
// =============================================================================

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const INVALID_UUID = "not-a-uuid";

// =============================================================================
// Tests
// =============================================================================

describe("press actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
  });

  // ===========================================================================
  // fetchGroupPressSourcesAction
  // ===========================================================================

  describe("fetchGroupPressSourcesAction", () => {
    it("returns empty object when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupPressSourcesAction(VALID_UUID);
        expect(result).toEqual({});
      }));

    it("returns empty object for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupPressSourcesAction(INVALID_UUID);
        expect(result).toEqual({});
      }));

    it("returns empty object when group does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupPressSourcesAction(VALID_UUID);
        expect(result).toEqual({});
      }));

    it("returns press sources from group metadata", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: {
            pressSources: {
              substackUrl: "https://myblog.substack.com",
              youtubeUrl: "https://youtube.com/@mychannel",
              instagramHandle: "myinsta",
            },
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupPressSourcesAction(group.id);
        expect(result.substackUrl).toBe("https://myblog.substack.com");
        expect(result.youtubeUrl).toBe("https://youtube.com/@mychannel");
        expect(result.instagramHandle).toBe("myinsta");
      }));

    it("falls back to socialLinks when pressSources is absent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: {
            socialLinks: {
              substack: "https://fallback.substack.com",
              youtube: "https://youtube.com/@fallback",
              instagram: "fallback_ig",
            },
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupPressSourcesAction(group.id);
        expect(result.substackUrl).toBe("https://fallback.substack.com");
        expect(result.youtubeUrl).toBe("https://youtube.com/@fallback");
        expect(result.instagramHandle).toBe("fallback_ig");
      }));
  });

  // ===========================================================================
  // updateGroupPressSourcesAction
  // ===========================================================================

  describe("updateGroupPressSourcesAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateGroupPressSourcesAction(VALID_UUID, {});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Authentication required");
      }));

    it("returns error for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateGroupPressSourcesAction(INVALID_UUID, {});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid group");
      }));

    it("returns error when user is not a group admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(false);

        const result = await updateGroupPressSourcesAction(group.id, {});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Only group admins");
      }));

    it("returns error when group does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(true);

        const result = await updateGroupPressSourcesAction(VALID_UUID, {});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Group not found");
      }));

    it("updates press sources when user is admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(true);

        const result = await updateGroupPressSourcesAction(group.id, {
          substackUrl: "https://newblog.substack.com",
          youtubeUrl: "https://youtube.com/@newchannel",
          instagramHandle: "@newinsta",
        });

        expect(result.success).toBe(true);

        // Verify sources were persisted
        const sources = await fetchGroupPressSourcesAction(group.id);
        expect(sources.substackUrl).toContain("newblog.substack.com");
        expect(sources.youtubeUrl).toContain("youtube.com/@newchannel");
        expect(sources.instagramHandle).toBe("newinsta");
      }));

    it("normalizes instagram handle by removing @", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(true);

        await updateGroupPressSourcesAction(group.id, {
          instagramHandle: "@myhandle",
        });

        const sources = await fetchGroupPressSourcesAction(group.id);
        expect(sources.instagramHandle).toBe("myhandle");
      }));

    it("normalizes URLs by prepending https:// if missing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(isGroupAdmin).mockResolvedValue(true);

        await updateGroupPressSourcesAction(group.id, {
          substackUrl: "myblog.substack.com",
        });

        const sources = await fetchGroupPressSourcesAction(group.id);
        expect(sources.substackUrl).toBe("https://myblog.substack.com");
      }));
  });

  // ===========================================================================
  // fetchGroupPressFeedAction
  // ===========================================================================

  describe("fetchGroupPressFeedAction", () => {
    it("returns empty result when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupPressFeedAction(VALID_UUID);
        expect(result.articles).toEqual([]);
        expect(result.media).toEqual([]);
        expect(result.sources).toEqual({});
      }));

    it("returns empty feed when group has no press sources", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { metadata: {} });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupPressFeedAction(group.id);
        expect(result.articles).toEqual([]);
        expect(result.media).toEqual([]);
      }));
  });
});
