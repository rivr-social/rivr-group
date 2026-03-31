"use client";

/**
 * New Message Dialog - search for users and start a DM or group conversation.
 *
 * Supports multi-select: users appear as removable chips above the search input.
 * A single selection creates a 1-on-1 DM; multiple selections create a group chat.
 * The "Start Chat" button triggers room creation via the parent callback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { searchAgentsByName } from "@/app/actions/graph";
import type { SerializedAgent } from "@/lib/graph-serializers";

const DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 15;

/** Minimal agent info retained for selected chips. */
export interface SelectedUser {
  id: string;
  name: string;
  image: string | null;
}

interface NewMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the array of selected agent IDs when the user clicks Start Chat. */
  onStartChat?: (agentIds: string[]) => void;
  /** @deprecated — use onStartChat instead. Kept for backward compat with single-select callers. */
  onSelectUser?: (agentId: string) => void;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function NewMessageDialog({
  open,
  onOpenChange,
  onStartChat,
  onSelectUser,
}: NewMessageDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SerializedAgent[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SelectedUser[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    try {
      const agents = await searchAgentsByName(term.trim(), SEARCH_LIMIT);
      const people = agents.filter((a) => a.type === "person");
      setResults(people);
    } catch (err) {
      console.error("[new-message] search failed:", err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(() => {
      search(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearching(false);
      setSelected([]);
    }
  }, [open]);

  const handleToggleUser = (agent: SerializedAgent) => {
    setSelected((prev) => {
      const exists = prev.find((u) => u.id === agent.id);
      if (exists) {
        return prev.filter((u) => u.id !== agent.id);
      }
      return [...prev, { id: agent.id, name: agent.name, image: agent.image }];
    });
    // Clear search after selection so user can search for another
    setQuery("");
    setResults([]);
    // Refocus input for quick multi-select
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRemoveUser = (userId: string) => {
    setSelected((prev) => prev.filter((u) => u.id !== userId));
  };

  const handleStartChat = () => {
    if (selected.length === 0) return;

    const agentIds = selected.map((u) => u.id);
    onOpenChange(false);

    if (onStartChat) {
      onStartChat(agentIds);
    } else if (onSelectUser && agentIds.length === 1) {
      // Backward compat fallback
      onSelectUser(agentIds[0]);
    }
  };

  // Filter out already-selected users from search results
  const selectedIds = new Set(selected.map((u) => u.id));
  const filteredResults = results.filter((a) => !selectedIds.has(a.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Message</DialogTitle>
          <DialogDescription>
            Search for people to start a conversation. Select multiple people for a group chat.
          </DialogDescription>
        </DialogHeader>

        {/* Selected user chips */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-1.5 bg-muted rounded-full pl-1 pr-2 py-1"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={user.image ?? undefined} alt={user.name} />
                  <AvatarFallback className="text-xs">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium truncate max-w-[120px]">
                  {user.name}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveUser(user.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                  aria-label={`Remove ${user.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="search"
            placeholder="Search by name..."
            className="pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="max-h-60 overflow-y-auto -mx-2">
          {searching && (
            <p className="text-center text-sm text-muted-foreground py-4">
              Searching...
            </p>
          )}

          {!searching && query.trim().length >= 2 && filteredResults.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-4">
              No people found
            </p>
          )}

          {filteredResults.map((agent) => {
            const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
            const username =
              typeof metadata.username === "string" ? metadata.username : "";

            return (
              <button
                key={agent.id}
                type="button"
                className="w-full text-left flex items-center gap-3 px-2 py-3 rounded-md hover:bg-muted/50 transition-colors"
                onClick={() => handleToggleUser(agent)}
              >
                <Avatar className="h-10 w-10">
                  <AvatarImage
                    src={agent.image ?? undefined}
                    alt={agent.name}
                  />
                  <AvatarFallback>{initials(agent.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{agent.name}</p>
                  {username && (
                    <p className="text-sm text-muted-foreground truncate">
                      @{username}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Start Chat button */}
        <Button
          onClick={handleStartChat}
          disabled={selected.length === 0}
          className="w-full"
        >
          {selected.length <= 1
            ? "Start Chat"
            : `Start Group Chat (${selected.length} people)`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
