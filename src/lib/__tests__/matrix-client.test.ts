import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mock matrix-js-sdk
// =============================================================================

const mockClient = {
  getUserId: vi.fn(() => "@user1:test.local"),
  stopClient: vi.fn(),
  startClient: vi.fn(),
  once: vi.fn((_event: string, cb: (state: string) => void) => {
    // Immediately resolve sync
    cb("PREPARED");
  }),
  on: vi.fn(),
  removeListener: vi.fn(),
  getRooms: vi.fn(() => []),
  getRoom: vi.fn(),
  getAccountData: vi.fn(),
  setAccountData: vi.fn(),
  sendMessage: vi.fn(() => Promise.resolve({ event_id: "$evt1" })),
  createRoom: vi.fn(() => Promise.resolve({ room_id: "!newroom:test.local" })),
  sendReadReceipt: vi.fn(),
};

vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(() => mockClient),
  MsgType: { Text: "m.text" },
  Preset: { TrustedPrivateChat: "trusted_private_chat" },
  ClientEvent: { Sync: "sync" },
  EventType: { Direct: "m.direct" },
  RoomEvent: { Timeline: "Room.timeline" },
}));

vi.mock("@/app/actions/matrix", () => ({
  ensureUserJoinedRoom: vi.fn(() => Promise.resolve()),
}));

const {
  getMatrixClient,
  startSync,
  stopSync,
  sendMessage,
  getOrCreateDmRoom,
  getDmRooms,
} = await import("@/lib/matrix-client");

describe("matrix-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module singleton by stopping any existing client
    stopSync();
  });

  describe("getMatrixClient", () => {
    it("creates a new MatrixClient on first call", () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      expect(client).toBeDefined();
      expect(client.getUserId()).toBe("@user1:test.local");
    });

    it("returns cached client for same userId", () => {
      const client1 = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const client2 = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      expect(client1).toBe(client2);
    });
  });

  describe("startSync", () => {
    it("starts the client and waits for PREPARED state", async () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await startSync(client);

      expect(mockClient.startClient).toHaveBeenCalledWith({
        initialSyncLimit: 20,
      });
      expect(mockClient.once).toHaveBeenCalledWith(
        "sync",
        expect.any(Function)
      );
    });
  });

  describe("stopSync", () => {
    it("stops the client and clears the singleton", () => {
      getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      stopSync();

      expect(mockClient.stopClient).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends a text message and returns event ID", async () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const result = await sendMessage(client, "!room1:test.local", "Hello!");

      expect(result.eventId).toBe("$evt1");
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        "!room1:test.local",
        {
          msgtype: "m.text",
          body: "Hello!",
        }
      );
    });
  });

  describe("getDmRooms", () => {
    it("returns empty array when no m.direct account data", () => {
      mockClient.getAccountData.mockReturnValue(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const rooms = getDmRooms(client);
      expect(rooms).toEqual([]);
    });

    it("filters rooms by m.direct room IDs", () => {
      const mockRoom1 = { roomId: "!dm1:test.local" };
      const mockRoom2 = { roomId: "!group1:test.local" };

      mockClient.getAccountData.mockReturnValue({
        getContent: () => ({
          "@bob:test.local": ["!dm1:test.local"],
        }),
      });
      mockClient.getRooms.mockReturnValue([mockRoom1, mockRoom2]);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const rooms = getDmRooms(client);
      expect(rooms).toHaveLength(1);
      expect(rooms[0].roomId).toBe("!dm1:test.local");
    });
  });

  describe("getOrCreateDmRoom", () => {
    it("creates a new room when no existing DM found", async () => {
      mockClient.getRooms.mockReturnValue([]);
      mockClient.getAccountData.mockReturnValue({
        getContent: () => ({}),
      });
      mockClient.setAccountData.mockResolvedValue(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const roomId = await getOrCreateDmRoom(client, "@newuser:test.local");

      expect(roomId).toBe("!newroom:test.local");
      expect(mockClient.createRoom).toHaveBeenCalledWith({
        is_direct: true,
        invite: ["@newuser:test.local"],
        preset: "trusted_private_chat",
      });
    });
  });
});
