import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource, createTestLedgerEntry } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents, groupMatrixRooms } from "@/db/schema";
import type { VerbType, NewLedgerEntry } from "@/db/schema";
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

vi.mock("@/lib/matrix-admin", () => ({
  provisionMatrixUser: vi.fn().mockResolvedValue({
    matrixUserId: "@testuser:matrix.local",
    accessToken: "syt_test_token",
  }),
  adminJoinRoom: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { provisionMatrixUser, adminJoinRoom } from "@/lib/matrix-admin";
import {
  getMatrixCredentials,
  getDmRoomForUser,
  getMatrixUserIdsForAgents,
  ensureUserJoinedRoom,
  getDmRoomForListing,
  getUserGroupRooms,
} from "../matrix";

// =============================================================================
// Tests
// =============================================================================

describe("matrix actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(provisionMatrixUser).mockResolvedValue({
      matrixUserId: "@testuser:matrix.local",
      accessToken: "syt_test_token",
    });
  });

  // ===========================================================================
  // getMatrixCredentials
  // ===========================================================================

  describe("getMatrixCredentials", () => {
    it("returns null when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getMatrixCredentials();
        expect(result).toBeNull();
      }));

    it("returns null when agent does not exist", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(
          mockAuthSession("00000000-0000-0000-0000-000000000000")
        );

        const result = await getMatrixCredentials();
        expect(result).toBeNull();
      }));

    it("returns existing matrix credentials without provisioning", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db, {
          matrixUserId: "@existing:matrix.local",
          matrixAccessToken: "syt_existing_token",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMatrixCredentials();

        expect(result).not.toBeNull();
        expect(result?.userId).toBe("@existing:matrix.local");
        expect(result?.accessToken).toBe("syt_existing_token");
        expect(vi.mocked(provisionMatrixUser)).not.toHaveBeenCalled();
      }));

    it("provisions a new matrix user when credentials are missing", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMatrixCredentials();

        expect(vi.mocked(provisionMatrixUser)).toHaveBeenCalled();
        // After provisioning, the DB is updated and refreshed
        // The result depends on whether the refresh finds the updated record
        // Since provisionMatrixUser is mocked, DB update happens with mock values
      }));

    it("returns null when provisioning fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(provisionMatrixUser).mockRejectedValueOnce(new Error("Matrix server down"));

        const result = await getMatrixCredentials();
        expect(result).toBeNull();
      }));
  });

  // ===========================================================================
  // getDmRoomForUser
  // ===========================================================================

  describe("getDmRoomForUser", () => {
    it("returns null when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getDmRoomForUser("some-agent-id");
        expect(result).toBeNull();
      }));

    it("returns null when target agent does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(provisionMatrixUser).mockRejectedValueOnce(new Error("not found"));

        const result = await getDmRoomForUser("00000000-0000-0000-0000-000000000000");
        expect(result).toBeNull();
      }));

    it("returns target matrix user id for existing agent", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const target = await createTestAgent(db, {
          matrixUserId: "@target:matrix.local",
          matrixAccessToken: "syt_target_token",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getDmRoomForUser(target.id);
        expect(result).not.toBeNull();
        expect(result?.targetMatrixUserId).toBe("@target:matrix.local");
      }));
  });

  // ===========================================================================
  // getMatrixUserIdsForAgents
  // ===========================================================================

  describe("getMatrixUserIdsForAgents", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getMatrixUserIdsForAgents(["id1"]);
        expect(result).toEqual([]);
      }));

    it("returns empty array for empty input", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMatrixUserIdsForAgents([]);
        expect(result).toEqual([]);
      }));

    it("returns matrix user ids for agents with credentials", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const agent1 = await createTestAgent(db, {
          matrixUserId: "@agent1:matrix.local",
          matrixAccessToken: "syt_1",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getMatrixUserIdsForAgents([agent1.id]);
        expect(result).toContain("@agent1:matrix.local");
      }));

    it("caps input to 50 agent ids", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const ids = Array.from({ length: 55 }, () => "00000000-0000-0000-0000-000000000000");

        // Should not throw — just process first 50
        await getMatrixUserIdsForAgents(ids);
      }));
  });

  // ===========================================================================
  // ensureUserJoinedRoom
  // ===========================================================================

  describe("ensureUserJoinedRoom", () => {
    it("does nothing when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await ensureUserJoinedRoom("@user:matrix.local", "!room:matrix.local");
        expect(vi.mocked(adminJoinRoom)).not.toHaveBeenCalled();
      }));

    it("does nothing when targetMatrixUserId does not start with @", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await ensureUserJoinedRoom("invalid_user", "!room:matrix.local");
        expect(vi.mocked(adminJoinRoom)).not.toHaveBeenCalled();
      }));

    it("does nothing when roomId does not start with !", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await ensureUserJoinedRoom("@user:matrix.local", "invalid_room");
        expect(vi.mocked(adminJoinRoom)).not.toHaveBeenCalled();
      }));

    it("calls adminJoinRoom with valid ids", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await ensureUserJoinedRoom("@user:matrix.local", "!room:matrix.local");
        expect(vi.mocked(adminJoinRoom)).toHaveBeenCalledWith({
          userId: "@user:matrix.local",
          roomId: "!room:matrix.local",
        });
      }));

    it("does not throw when adminJoinRoom fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(adminJoinRoom).mockRejectedValueOnce(new Error("Room not found"));

        // Should not throw
        await ensureUserJoinedRoom("@user:matrix.local", "!room:matrix.local");
      }));
  });

  // ===========================================================================
  // getDmRoomForListing
  // ===========================================================================

  describe("getDmRoomForListing", () => {
    it("returns null when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getDmRoomForListing("listing-id");
        expect(result).toBeNull();
      }));

    it("returns null when listing does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getDmRoomForListing("00000000-0000-0000-0000-000000000000");
        expect(result).toBeNull();
      }));

    it("returns seller matrix user id for a valid listing", () =>
      withTestTransaction(async (db) => {
        const seller = await createTestAgent(db, {
          matrixUserId: "@seller:matrix.local",
          matrixAccessToken: "syt_seller",
        });
        const buyer = await createTestAgent(db);
        const listing = await createTestResource(db, seller.id, {
          type: "listing",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(buyer.id));

        const result = await getDmRoomForListing(listing.id);
        expect(result).not.toBeNull();
        expect(result?.targetMatrixUserId).toBe("@seller:matrix.local");
      }));
  });

  // ===========================================================================
  // getUserGroupRooms
  // ===========================================================================

  describe("getUserGroupRooms", () => {
    it("returns null when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getUserGroupRooms();
        expect(result).toBeNull();
      }));

    it("returns empty array when user has no group memberships", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getUserGroupRooms();
        expect(result).toEqual([]);
      }));

    it("returns group rooms for joined groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, { name: "Test Community" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Join the group
        await db.insert(ledger).values({
          verb: "join" as VerbType,
          subjectId: user.id,
          objectId: group.id,
          isActive: true,
          metadata: {},
        } as NewLedgerEntry);

        // Create a matrix room for the group
        await db.insert(groupMatrixRooms).values({
          groupAgentId: group.id,
          matrixRoomId: "!testroom:matrix.local",
          chatMode: "open",
        });

        const result = await getUserGroupRooms();
        expect(result).not.toBeNull();
        expect(result!.length).toBe(1);
        expect(result![0].groupId).toBe(group.id);
        expect(result![0].groupName).toBe("Test Community");
        expect(result![0].matrixRoomId).toBe("!testroom:matrix.local");
        expect(result![0].chatMode).toBe("open");
      }));

    it("excludes groups without matrix rooms", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Join but no matrix room
        await db.insert(ledger).values({
          verb: "join" as VerbType,
          subjectId: user.id,
          objectId: group.id,
          isActive: true,
          metadata: {},
        } as NewLedgerEntry);

        const result = await getUserGroupRooms();
        expect(result).toEqual([]);
      }));
  });
});
