import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestLedgerEntry } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger } from "@/db/schema";
import type { NewLedgerEntry, VerbType } from "@/db/schema";

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

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  fetchNotifications,
  fetchNotificationReadState,
  setNotificationReadState,
  markAllNotificationsAsRead,
} from "../inbox";

// =============================================================================
// Tests
// =============================================================================

describe("inbox actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // fetchNotifications
  // ===========================================================================

  describe("fetchNotifications", () => {
    it("returns empty array when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchNotifications();
        expect(result).toEqual([]);
      }));

    it("returns empty array when user has no notifications", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchNotifications();
        expect(result).toEqual([]);
      }));

    it("returns notifications targeting the current user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const actor = await createTestAgent(db, { name: "Follower" });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Create a notification entry (actor follows user)
        await db.insert(ledger).values({
          verb: "follow" as VerbType,
          subjectId: actor.id,
          objectId: user.id,
          objectType: "agent",
          metadata: {},
        } as NewLedgerEntry);

        const result = await fetchNotifications();

        expect(result.length).toBe(1);
        expect(result[0].type).toBe("follow");
        expect(result[0].actorId).toBe(actor.id);
        expect(result[0].actorName).toBe("Follower");
        expect(result[0].message).toBe("started following you");
      }));

    it("excludes self-authored entries", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Self-targeted entry should be excluded
        await db.insert(ledger).values({
          verb: "view" as VerbType,
          subjectId: user.id,
          objectId: user.id,
          objectType: "agent",
          metadata: {},
        } as NewLedgerEntry);

        const result = await fetchNotifications();
        expect(result).toEqual([]);
      }));

    it("maps verb labels correctly for known verbs", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const actor = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const verbs: VerbType[] = ["comment", "react", "join", "invite", "attend"];
        const expectedMessages = ["commented", "reacted", "joined", "invited you", "RSVP'd"];

        for (const verb of verbs) {
          await db.insert(ledger).values({
            verb,
            subjectId: actor.id,
            objectId: user.id,
            objectType: "agent",
            metadata: {},
          } as NewLedgerEntry);
        }

        const result = await fetchNotifications();
        expect(result.length).toBe(verbs.length);

        for (let i = 0; i < verbs.length; i++) {
          const notification = result.find((n) => n.type === verbs[i]);
          expect(notification?.message).toBe(expectedMessages[i]);
        }
      }));

    it("uses explicit message from metadata when present", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const actor = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await db.insert(ledger).values({
          verb: "follow" as VerbType,
          subjectId: actor.id,
          objectId: user.id,
          objectType: "agent",
          metadata: { message: "Custom notification message" },
        } as NewLedgerEntry);

        const result = await fetchNotifications();
        expect(result[0].message).toBe("Custom notification message");
      }));

    it("respects the limit parameter", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const actor = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Create 5 notifications
        for (let i = 0; i < 5; i++) {
          await db.insert(ledger).values({
            verb: "follow" as VerbType,
            subjectId: actor.id,
            objectId: user.id,
            objectType: "agent",
            metadata: {},
          } as NewLedgerEntry);
        }

        const result = await fetchNotifications(2);
        expect(result.length).toBe(2);
      }));

    it("serializes timestamp to ISO string", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const actor = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await db.insert(ledger).values({
          verb: "follow" as VerbType,
          subjectId: actor.id,
          objectId: user.id,
          objectType: "agent",
          metadata: {},
        } as NewLedgerEntry);

        const result = await fetchNotifications();
        expect(result[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }));
  });

  // ===========================================================================
  // fetchNotificationReadState
  // ===========================================================================

  describe("fetchNotificationReadState", () => {
    it("returns empty object when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchNotificationReadState(["id1"]);
        expect(result).toEqual({});
      }));

    it("returns empty object for empty ids array", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchNotificationReadState([]);
        expect(result).toEqual({});
      }));

    it("returns read state for marked notifications", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Mark a notification as read
        await setNotificationReadState({ notificationId: "notif-1", isRead: true });

        const result = await fetchNotificationReadState(["notif-1"]);
        expect(result["notif-1"]).toBe(true);
      }));

    it("returns empty object for unread notifications", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchNotificationReadState(["nonexistent"]);
        expect(result).toEqual({});
      }));
  });

  // ===========================================================================
  // setNotificationReadState
  // ===========================================================================

  describe("setNotificationReadState", () => {
    it("does nothing when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        // Should not throw
        await setNotificationReadState({ notificationId: "id1", isRead: true });
      }));

    it("does nothing when notificationId is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Should not throw
        await setNotificationReadState({ notificationId: "", isRead: true });
      }));

    it("creates a ledger entry marking notification as read", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setNotificationReadState({ notificationId: "notif-abc", isRead: true });

        const state = await fetchNotificationReadState(["notif-abc"]);
        expect(state["notif-abc"]).toBe(true);
      }));

    it("creates a ledger entry marking notification as unread", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setNotificationReadState({ notificationId: "notif-xyz", isRead: false });

        const state = await fetchNotificationReadState(["notif-xyz"]);
        expect(state["notif-xyz"]).toBe(false);
      }));
  });

  // ===========================================================================
  // markAllNotificationsAsRead
  // ===========================================================================

  describe("markAllNotificationsAsRead", () => {
    it("does nothing when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        // Should not throw
        await markAllNotificationsAsRead(["id1", "id2"]);
      }));

    it("does nothing when ids array is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Should not throw
        await markAllNotificationsAsRead([]);
      }));

    it("marks multiple notifications as read", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const ids = ["notif-a", "notif-b", "notif-c"];
        await markAllNotificationsAsRead(ids);

        const state = await fetchNotificationReadState(ids);
        expect(state["notif-a"]).toBe(true);
        expect(state["notif-b"]).toBe(true);
        expect(state["notif-c"]).toBe(true);
      }));

    it("caps at 1000 notification ids", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Generate 1005 ids - should only process 1000
        const ids = Array.from({ length: 1005 }, (_, i) => `notif-${i}`);

        // Should not throw
        await markAllNotificationsAsRead(ids);

        // Verify at least first ones were processed
        const state = await fetchNotificationReadState(["notif-0", "notif-999"]);
        expect(state["notif-0"]).toBe(true);
        expect(state["notif-999"]).toBe(true);
      }));
  });
});
