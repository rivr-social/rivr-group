"use client";

/**
 * Hybrid group chat panel supporting ledger (knowledge graph), Matrix (private),
 * or both modes simultaneously.
 *
 * - "ledger" mode: Renders the group's activity feed (posts, resources, events).
 * - "matrix" mode: Full real-time Matrix chat via MatrixChatPanel.
 * - "both" mode: Tabbed interface switching between Matrix chat and ledger feed.
 */

import { useState } from "react";
import { MatrixChatPanel } from "./matrix-chat-panel";
import { Button } from "@/components/ui/button";
import { MessageSquare, Newspaper } from "lucide-react";
import type { MatrixClient } from "matrix-js-sdk";
import type { ChatMode } from "@/db/schema";

interface GroupChatPanelProps {
  /** Current chat mode for this group */
  chatMode: ChatMode;
  /** Group display name */
  groupName: string;
  /** Group avatar URL */
  groupAvatarUrl?: string | null;
  /** Matrix client instance (required for "matrix" and "both" modes) */
  matrixClient?: MatrixClient | null;
  /** Matrix room ID for this group (required for "matrix" and "both" modes) */
  matrixRoomId?: string | null;
  /** Current user's Matrix user ID */
  currentUserId?: string;
  /** Ledger feed content — rendered when mode is "ledger" or "both" */
  ledgerFeedContent?: React.ReactNode;
  /** Callback when back button is pressed */
  onBack?: () => void;
}

type ActiveTab = "chat" | "feed";

export function GroupChatPanel({
  chatMode,
  groupName,
  groupAvatarUrl,
  matrixClient,
  matrixRoomId,
  currentUserId,
  ledgerFeedContent,
  onBack,
}: GroupChatPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");

  const hasMatrix = matrixClient && matrixRoomId && currentUserId;

  // "ledger" mode — just show the feed content
  if (chatMode === "ledger") {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <h2 className="font-medium">{groupName}</h2>
          <p className="text-xs text-muted-foreground">Group discussions</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {ledgerFeedContent ?? (
            <p className="text-center text-muted-foreground py-8">
              No discussions yet
            </p>
          )}
        </div>
      </div>
    );
  }

  // "matrix" mode — just the Matrix chat panel
  if (chatMode === "matrix") {
    if (!hasMatrix) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Matrix chat is not configured for this group.
        </div>
      );
    }

    return (
      <MatrixChatPanel
        client={matrixClient}
        roomId={matrixRoomId}
        currentUserId={currentUserId}
        roomName={groupName}
        roomAvatarUrl={groupAvatarUrl}
        onBack={onBack}
      />
    );
  }

  // "both" mode — tabbed interface
  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b">
        <Button
          variant="ghost"
          className={`flex-1 rounded-none gap-2 ${
            activeTab === "chat"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground"
          }`}
          onClick={() => setActiveTab("chat")}
        >
          <MessageSquare className="h-4 w-4" />
          Chat
        </Button>
        <Button
          variant="ghost"
          className={`flex-1 rounded-none gap-2 ${
            activeTab === "feed"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground"
          }`}
          onClick={() => setActiveTab("feed")}
        >
          <Newspaper className="h-4 w-4" />
          Feed
        </Button>
      </div>

      {/* Tab content */}
      {activeTab === "chat" ? (
        hasMatrix ? (
          <MatrixChatPanel
            client={matrixClient}
            roomId={matrixRoomId}
            currentUserId={currentUserId}
            roomName={groupName}
            roomAvatarUrl={groupAvatarUrl}
            onBack={onBack}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Matrix chat is not configured for this group.
          </div>
        )
      ) : (
        <div className="flex-1 overflow-y-auto">
          {ledgerFeedContent ?? (
            <p className="text-center text-muted-foreground py-8">
              No discussions yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}
