import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn((key: string) => {
    const env: Record<string, string> = {
      MATRIX_HOMESERVER_URL: "https://matrix.test.local",
      MATRIX_ADMIN_TOKEN: "syt_admin_token",
      MATRIX_SERVER_NAME: "test.local",
    };
    return env[key] ?? "";
  }),
}));

const mockGroupMatrixRoomsInsert = vi.fn();
const mockGroupMatrixRoomsUpdate = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      groupMatrixRooms: {
        findFirst: vi.fn(),
      },
      agents: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "record-uuid-123" }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));

vi.mock("@/db/schema", async () => {
  return {
    agents: { id: "id" },
    groupMatrixRooms: {
      groupAgentId: "group_agent_id",
      id: "id",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { db } = await import("@/db");
type AgentRow = { matrixUserId: string | null };
const {
  createGroupMatrixRoom,
  inviteToGroupRoom,
  removeFromGroupRoom,
  setGroupChatMode,
  getGroupMatrixRoom,
} = await import("@/lib/matrix-groups");

describe("matrix-groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createGroupMatrixRoom", () => {
    it("returns existing room if already created", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "existing-record",
        groupAgentId: "group-1",
        matrixRoomId: "!existing:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await createGroupMatrixRoom({
        groupAgentId: "group-1",
        groupName: "Test Group",
        creatorMatrixUserId: "@admin:test.local",
      });

      expect(result.matrixRoomId).toBe("!existing:test.local");
      expect(result.recordId).toBe("existing-record");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("creates new room as the creator via the client-server API when none exists", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      // 1st fetch = short-lived admin login token for the creator;
      // 2nd fetch = client-server createRoom AS the creator. Room creation
      // must NOT go through the nonexistent Synapse admin endpoint
      // (POST /_synapse/admin/v1/rooms -> 405 M_UNRECOGNIZED).
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "syt_test_token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ room_id: "!newgroup:test.local" }),
        });

      const result = await createGroupMatrixRoom({
        groupAgentId: "group-2",
        groupName: "New Group",
        creatorMatrixUserId: "@creator:test.local",
        chatMode: "matrix",
      });

      expect(result.matrixRoomId).toBe("!newgroup:test.local");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [loginUrl, loginOpts] = mockFetch.mock.calls[0];
      expect(loginUrl).toContain("/_synapse/admin/v1/users/");
      expect(loginUrl).toContain("/login");
      expect(loginOpts.method).toBe("POST");

      const [createUrl, createOpts] = mockFetch.mock.calls[1];
      expect(createUrl).toContain("/_matrix/client/v3/createRoom");
      expect(createOpts.method).toBe("POST");
      expect(createOpts.headers.Authorization).toBe("Bearer syt_test_token");

      const body = JSON.parse(createOpts.body);
      expect(body.name).toBe("New Group");
      expect(body.preset).toBe("private_chat");
    });
  });

  describe("inviteToGroupRoom", () => {
    it("throws when no Matrix room exists for group", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      await expect(
        inviteToGroupRoom({
          groupAgentId: "group-no-room",
          targetAgentId: "user-1",
        })
      ).rejects.toThrow("No Matrix room found for group");
    });

    it("throws when target agent has no Matrix account", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: null,
      } as AgentRow);

      await expect(
        inviteToGroupRoom({
          groupAgentId: "group-1",
          targetAgentId: "user-no-matrix",
        })
      ).rejects.toThrow("Could not resolve or provision a Matrix account");
    });

    it("invites user when both room and Matrix account exist", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: "@invited:test.local",
      } as AgentRow);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await inviteToGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/_synapse/admin/v1/join/");
      expect(JSON.parse(opts.body).user_id).toBe("@invited:test.local");
    });
  });

  describe("removeFromGroupRoom", () => {
    it("no-ops when no Matrix room exists", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      await removeFromGroupRoom({
        groupAgentId: "group-none",
        targetAgentId: "user-1",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("no-ops when target has no Matrix account", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: null,
      } as AgentRow);

      await removeFromGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-no-matrix",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("kicks user from room when both exist", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: "@kicked:test.local",
      } as AgentRow);

      mockFetch.mockResolvedValueOnce({ ok: true });

      await removeFromGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/kick");
      expect(JSON.parse(opts.body).user_id).toBe("@kicked:test.local");
    });
  });
});
