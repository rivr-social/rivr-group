"use client";

/**
 * Direct messages page powered by Matrix/Synapse.
 *
 * Route: `/messages` (optional query param: `?user=<recipientAgentId>` to open a DM).
 *
 * Lifecycle:
 * 1. Fetch Matrix credentials from the server.
 * 2. Initialize matrix-js-sdk client, start sync, wait for PREPARED.
 * 3. Read DM rooms from m.direct account data → populate ConversationList.
 * 4. On room select → render MatrixChatPanel with real-time sync.
 * 5. Deep-link via `?user=` → resolve target Matrix user → getOrCreateDmRoom.
 * 6. On unmount → stop Matrix sync.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  getMatrixClient,
  startSync,
  stopSync,
  getDmRooms,
  getOrCreateDmRoom,
  createGroupDmRoom,
  leaveRoom,
} from "@/lib/matrix-client";
import {
  getMatrixCredentials,
  getDmRoomForListing,
  getDmRoomForUser,
  getMatrixUserIdsForAgents,
  getUserGroupRooms,
} from "@/app/actions/matrix";
import {
  ConversationList,
  type ConversationSummary,
} from "@/components/chat/conversation-list";
import { MatrixChatPanel } from "@/components/chat/matrix-chat-panel";
import { GroupChatPanel } from "@/components/chat/group-chat-panel";
import type { ChatMode } from "@/db/schema";
import { NotificationCountType, RoomEvent } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

/**
 * Extracts conversation summaries from Matrix DM rooms.
 */
function roomsToConversations(
  client: MatrixClient,
  rooms: Room[]
): ConversationSummary[] {
  return rooms
    .map((room): ConversationSummary => {
      const timeline = room.getLiveTimeline().getEvents();
      const lastMsg = [...timeline]
        .reverse()
        .find((ev: MatrixEvent) => ev.getType() === "m.room.message");

      // Determine the "other" user in a DM
      const members = room.getJoinedMembers();
      const otherMember = members.find(
        (m) => m.userId !== client.getUserId()
      );
      const displayName =
        otherMember?.name ?? room.name ?? room.roomId;

      const avatarUrl = otherMember?.getAvatarUrl(
        client.getHomeserverUrl(),
        48,
        48,
        "crop",
        false,
        false
      ) ?? null;

      // Unread count from room notification state
      const unreadCount = room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;

      return {
        roomId: room.roomId,
        name: displayName,
        avatarUrl,
        lastMessage: lastMsg?.getContent().body ?? null,
        lastMessageTs: lastMsg?.getTs() ?? null,
        unreadCount,
      };
    })
    .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
}

/** Group room data shape returned by the server action. */
type GroupRoomData = {
  groupId: string;
  groupName: string;
  groupImage: string | null;
  matrixRoomId: string;
  chatMode: string;
  subgroups: { id: string; name: string; matrixRoomId: string | null }[];
};

/**
 * Converts group room data into ConversationSummary entries by reading
 * timeline state from the Matrix client for each room.
 */
function groupRoomsToConversations(
  client: MatrixClient,
  groupRooms: GroupRoomData[]
): ConversationSummary[] {
  return groupRooms
    .map((gr): ConversationSummary | null => {
      const room = client.getRoom(gr.matrixRoomId);
      if (!room) return null;

      const timeline = room.getLiveTimeline().getEvents();
      const lastMsg = [...timeline]
        .reverse()
        .find((ev: MatrixEvent) => ev.getType() === "m.room.message");

      const unreadCount =
        room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;

      return {
        roomId: room.roomId,
        name: gr.groupName,
        avatarUrl: null,
        lastMessage: lastMsg?.getContent().body ?? null,
        lastMessageTs: lastMsg?.getTs() ?? null,
        unreadCount,
        type: 'group',
        groupId: gr.groupId,
      };
    })
    .filter((c): c is ConversationSummary => c !== null)
    .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
}

export default function MessagesPage() {
  const searchParams = useSearchParams();
  const userIdParam = searchParams.get("user");
  const listingIdParam = searchParams.get("listing");
  const groupIdParam = searchParams.get("group");

  const [matrixClient, setMatrixClient] = useState<MatrixClient | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [showConversationList, setShowConversationList] = useState(true);

  // Use ref for group room data to avoid re-render loops in useCallback/useEffect
  const groupRoomDataRef = useRef<GroupRoomData[]>([]);

  // Track whether the deep-link has been handled to prevent re-runs
  const deepLinkHandled = useRef(false);

  useEffect(() => {
    deepLinkHandled.current = false;
  }, [userIdParam, listingIdParam, groupIdParam]);

  /**
   * Refresh conversation list from current Matrix client state,
   * merging DM and group conversations sorted by most recent message.
   */
  const refreshConversations = useCallback(
    (client: MatrixClient, groupRooms?: GroupRoomData[]) => {
      const dmRooms = getDmRooms(client);
      const dmSummaries = roomsToConversations(client, dmRooms);

      if (groupRooms) {
        groupRoomDataRef.current = groupRooms;
      }
      const groupSummaries = groupRoomsToConversations(client, groupRoomDataRef.current);

      const merged = [...dmSummaries, ...groupSummaries].sort(
        (a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0)
      );
      setConversations(merged);
    },
    []
  );

  /**
   * Initialize Matrix client, start sync, populate conversations.
   */
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const creds = await getMatrixCredentials();
        if (cancelled) return;

        if (!creds) {
          setError("Matrix credentials not available. Please try again later.");
          setLoading(false);
          return;
        }

        const client = getMatrixClient({
          homeserverUrl: creds.homeserverUrl,
          userId: creds.userId,
          accessToken: creds.accessToken,
        });

        setMatrixClient(client);
        setCurrentUserId(creds.userId);

        await startSync(client);
        if (cancelled) return;

        // Fetch group rooms from the server and merge into conversations
        const groups = await getUserGroupRooms();
        if (cancelled) return;
        const fetchedGroupRooms = groups ?? [];
        refreshConversations(client, fetchedGroupRooms);
        setLoading(false);

        // Listen for timeline events to refresh conversation previews
        const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
          if (cancelled || !room) return;
          if (event.getType() === "m.room.message") {
            refreshConversations(client);
          }
        };

        client.on(RoomEvent.Timeline, onTimeline);

        // Store cleanup ref
        return () => {
          client.removeListener(RoomEvent.Timeline, onTimeline);
        };
      } catch (err) {
        if (cancelled) return;
        console.error("[messages] Matrix init failed:", err);
        setError("Failed to connect to messaging. Please try again.");
        setLoading(false);
      }
    }

    let cleanupListener: (() => void) | undefined;
    init().then((cleanup) => {
      cleanupListener = cleanup;
    });

    return () => {
      cancelled = true;
      cleanupListener?.();
      stopSync();
    };
  }, [refreshConversations]);

  /**
   * Handle deep-link: `?user=<agentId>` or `?listing=<id>` → find or create DM room.
   * Also supports `?group=<groupId>` → open that group's Matrix room.
   */
  useEffect(() => {
    const deepLinkTarget = userIdParam || listingIdParam || groupIdParam;

    if (!deepLinkTarget || !matrixClient || loading || deepLinkHandled.current) {
      return;
    }

    let cancelled = false;

    async function handleDeepLink() {
      if (!matrixClient) return;

      deepLinkHandled.current = true;

      try {
        // Handle group deep-link
        if (groupIdParam) {
          const groupRoom = groupRoomDataRef.current.find((g) => g.groupId === groupIdParam);
          if (!groupRoom) return;

          setActiveRoomId(groupRoom.matrixRoomId);
          setShowConversationList(false);
          return;
        }

        // Handle DM deep-link
        const result = userIdParam
          ? await getDmRoomForUser(userIdParam)
          : await getDmRoomForListing(listingIdParam!);
        if (cancelled || !result) return;

        // Find or create a DM room with that Matrix user
        const roomId = await getOrCreateDmRoom(
          matrixClient,
          result.targetMatrixUserId
        );
        if (cancelled) return;

        // Refresh conversations to include the new room
        refreshConversations(matrixClient);

        setActiveRoomId(roomId);
        setShowConversationList(false);
      } catch (err) {
        console.error("[messages] Deep link failed:", err);
      }
    }

    void handleDeepLink();

    return () => {
      cancelled = true;
    };
  }, [userIdParam, listingIdParam, groupIdParam, matrixClient, loading, refreshConversations]);

  /**
   * Auto-select first conversation when none is active (desktop).
   */
  useEffect(() => {
    if (activeRoomId || loading || conversations.length === 0) return;
    setActiveRoomId(conversations[0].roomId);
  }, [activeRoomId, loading, conversations]);

  const handleSelectConversation = (roomId: string) => {
    setActiveRoomId(roomId);
    setShowConversationList(false);
  };

  const handleBack = () => {
    setShowConversationList(true);
  };

  /**
   * Handle new chat creation from the multi-select dialog.
   * For a single user, finds or creates a 1-on-1 DM room.
   * For multiple users, creates a group DM room.
   * Directly uses the Matrix client — no router.push needed.
   */
  const handleStartChat = useCallback(
    async (agentIds: string[]) => {
      if (!matrixClient || agentIds.length === 0) return;

      try {
        let roomId: string;

        if (agentIds.length === 1) {
          // Single user — find or create 1-on-1 DM
          const result = await getDmRoomForUser(agentIds[0]);
          if (!result) {
            console.error("[messages] Could not resolve Matrix user ID for agent");
            return;
          }
          roomId = await getOrCreateDmRoom(matrixClient, result.targetMatrixUserId);
        } else {
          // Multiple users — create a group DM
          const matrixUserIds = await getMatrixUserIdsForAgents(agentIds);
          if (matrixUserIds.length === 0) {
            console.error("[messages] No Matrix user IDs resolved for selected agents");
            return;
          }
          roomId = await createGroupDmRoom(matrixClient, matrixUserIds);
        }

        // Refresh conversations to include the new room
        refreshConversations(matrixClient);

        // Navigate to the new room
        setActiveRoomId(roomId);
        setShowConversationList(false);
      } catch (err) {
        console.error("[messages] Failed to create chat:", err);
      }
    },
    [matrixClient, refreshConversations]
  );

  /** Handle deleting a conversation: leave the Matrix room and remove from list. */
  const handleDeleteConversation = useCallback(
    async (roomId: string) => {
      if (!matrixClient) return;
      try {
        await leaveRoom(matrixClient, roomId);
        // Remove from local state immediately
        setConversations((prev) => prev.filter((c) => c.roomId !== roomId));
        // Clear active room if it was the deleted one
        if (activeRoomId === roomId) {
          setActiveRoomId(null);
          setShowConversationList(true);
        }
      } catch (err) {
        console.error("[messages] Failed to delete conversation:", err);
      }
    },
    [matrixClient, activeRoomId]
  );

  // Find active conversation metadata
  const activeConversation = conversations.find(
    (c) => c.roomId === activeRoomId
  );

  if (error) {
    return (
      <div className="container max-w-4xl mx-auto px-4 py-6 h-[calc(100vh-8rem)] flex items-center justify-center">
        <p className="text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 h-[calc(100vh-8rem)] flex flex-col md:flex-row">
      {/* Conversation list sidebar */}
      <div
        className={`md:w-1/3 border-r flex flex-col ${
          showConversationList ? "flex" : "hidden md:flex"
        }`}
      >
        <ConversationList
          conversations={conversations}
          activeRoomId={activeRoomId}
          onSelect={handleSelectConversation}
          loading={loading}
          onStartChat={handleStartChat}
          onDelete={handleDeleteConversation}
        />
      </div>

      {/* Chat panel */}
      <div
        className={`${
          showConversationList ? "hidden md:flex" : "flex"
        } md:w-2/3 flex-col h-full`}
      >
        {matrixClient && activeRoomId && activeConversation ? (
          activeConversation.type === "group" ? (
            <GroupChatPanel
              chatMode={
                (groupRoomDataRef.current.find(
                  (g) => g.matrixRoomId === activeRoomId
                )?.chatMode ?? "both") as ChatMode
              }
              groupName={activeConversation.name}
              groupAvatarUrl={activeConversation.avatarUrl}
              matrixClient={matrixClient}
              matrixRoomId={activeRoomId}
              currentUserId={currentUserId}
              onBack={handleBack}
            />
          ) : (
            <MatrixChatPanel
              client={matrixClient}
              roomId={activeRoomId}
              currentUserId={currentUserId}
              roomName={activeConversation.name}
              roomAvatarUrl={activeConversation.avatarUrl}
              onBack={handleBack}
            />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            {loading
              ? "Connecting to Matrix..."
              : "Select a conversation to start messaging"}
          </div>
        )}
      </div>
    </div>
  );
}
