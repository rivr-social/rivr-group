"use client";

/**
 * GroupAssistantBubble — a floating chat launcher (FAB) for the group's AI
 * assistant, rendered app-wide for group admins.
 *
 * This is the always-available counterpart to the assistant's config surface in
 * `/groups/[id]/settings` (the Assistant tab). It opens a panel that hosts the
 * shared {@link GroupAssistantChat} widget, which POSTs to
 * `/api/groups/[id]/assistant/chat`. The chat route resolves the caller's tier
 * server-side, so an admin gets full knowledge-graph scope and the assistant's
 * act tools (connectors + group creation) — this component only decides whether
 * to render the launcher at all.
 *
 * Visibility is gated by the server (root layout) to the primary group's
 * owner/admins; the bubble is not rendered for members, visitors, or anonymous
 * viewers.
 */

import { useState } from "react";
import { Bot, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GroupAssistantChat } from "@/components/group-assistant-chat";

export function GroupAssistantBubble({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:opacity-90 active:scale-95 bottom-20 right-4 md:bottom-6 md:right-6"
        aria-label="Open group assistant"
      >
        <Bot className="h-6 w-6" />
      </button>
    );
  }

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        className={[
          "fixed z-50 flex flex-col overflow-hidden bg-background shadow-2xl",
          "inset-0 md:inset-auto md:bottom-24 md:right-6 md:w-[26rem] md:max-h-[calc(100dvh-8rem)] md:rounded-xl md:border",
        ].join(" ")}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Group assistant</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(false)}
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <GroupAssistantChat groupId={groupId} />
        </div>
      </div>
    </>
  );
}

export default GroupAssistantBubble;
