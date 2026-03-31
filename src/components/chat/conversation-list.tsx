"use client";

import { useState } from "react";
import { Search, SquarePen, Trash2, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NewMessageDialog } from "@/components/chat/new-message-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDistanceToNow } from "date-fns";

export interface ConversationSummary {
  roomId: string;
  name: string;
  avatarUrl: string | null;
  lastMessage: string | null;
  lastMessageTs: number | null;
  unreadCount: number;
  type?: 'dm' | 'group';
  groupId?: string;
}

interface ConversationListProps {
  conversations: ConversationSummary[];
  activeRoomId: string | null;
  onSelect: (roomId: string) => void;
  loading?: boolean;
  /** Called when the user picks people from the new-message dialog and clicks Start Chat. */
  onStartChat?: (agentIds: string[]) => void;
  /** Called when the user deletes a conversation thread. */
  onDelete?: (roomId: string) => void;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatConversationTime(ts: number | null) {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "recently";
  }
}

export function ConversationList({
  conversations,
  activeRoomId,
  onSelect,
  loading,
  onStartChat,
  onDelete,
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);

  const filtered = searchQuery.trim()
    ? conversations.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
      )
    : conversations;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between">
        <h1 className="text-2xl font-bold">Messages</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setNewMessageOpen(true)}
          title="New message"
        >
          <SquarePen className="h-5 w-5" />
        </Button>
        <NewMessageDialog
          open={newMessageOpen}
          onOpenChange={setNewMessageOpen}
          onStartChat={onStartChat}
        />
      </div>

      <div className="p-4">
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search messages..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="text-center text-muted-foreground py-6">
            Connecting to Matrix...
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-6">
            No conversations yet
          </p>
        ) : (
          filtered.map((convo) => {
            const isActive = convo.roomId === activeRoomId;
            const isUnread = convo.unreadCount > 0;

            return (
              <div
                key={convo.roomId}
                className={`group relative w-full text-left flex items-center gap-3 p-4 border-b hover:bg-muted/50 transition-colors cursor-pointer ${
                  isActive ? "bg-muted/60" : ""
                }`}
                onClick={() => onSelect(convo.roomId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(convo.roomId);
                  }
                }}
              >
                <div className="relative">
                  <Avatar className="h-11 w-11">
                    <AvatarImage
                      src={convo.avatarUrl ?? undefined}
                      alt={convo.name}
                    />
                    <AvatarFallback>{initials(convo.name)}</AvatarFallback>
                  </Avatar>
                  {convo.type === 'group' && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-primary text-primary-foreground rounded-full p-0.5">
                      <Users className="h-3 w-3" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center gap-2">
                    <p
                      className={`truncate ${
                        isUnread ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {convo.name}
                    </p>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatConversationTime(convo.lastMessageTs)}
                    </span>
                  </div>
                  <p
                    className={`text-sm truncate ${
                      isUnread ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {convo.lastMessage ?? "No messages yet"}
                  </p>
                </div>

                {isUnread && (
                  <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                )}

                {onDelete && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        title="More options"
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteTarget(convo)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete conversation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete your conversation with{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>
              ? You will leave this chat and it will be removed from your
              message list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget && onDelete) {
                  onDelete(deleteTarget.roomId);
                }
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
