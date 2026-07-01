"use client";

/**
 * GroupAssistantChat — an inline chat surface for talking to the group's AI
 * assistant.
 *
 * This is the request/response counterpart to the group assistant's config
 * card. It POSTs to `POST /api/groups/[id]/assistant/chat` with the running
 * message history and renders the assistant's reply. Because it is mounted
 * inside the admin-gated settings page, the caller is resolved server-side as
 * the group owner/admin — so replies run at full KG scope and the assistant is
 * offered its connector "act" tools. Any tools it invoked in a turn are shown
 * beneath the reply for transparency.
 *
 * The endpoint is stateless: the widget keeps the transcript in local state and
 * replays a bounded window of it on every turn (the server also caps history).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Bot, Loader2, Send, User, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Turns of history replayed to the endpoint (it caps at 20 messages). */
const MAX_HISTORY_TURNS = 10;
/** Mirrors the server-side per-message cap. */
const MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolAction {
  name: string;
  ok: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ToolAction[];
}

interface ChatResponseBody {
  reply?: string;
  model?: string;
  assistantName?: string;
  actions?: ToolAction[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupAssistantChat({ groupId }: { groupId: string }) {
  const { toast } = useToast();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    if (message.length > MAX_MESSAGE_LENGTH) {
      toast({
        title: "Message too long",
        description: `Keep messages under ${MAX_MESSAGE_LENGTH} characters.`,
        variant: "destructive",
      });
      return;
    }

    // Snapshot the history window BEFORE appending the new user turn.
    const history = messages.slice(-MAX_HISTORY_TURNS * 2).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));

    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setDraft("");
    setSending(true);

    try {
      const res = await fetch(`/api/groups/${groupId}/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = (await res.json().catch(() => ({}))) as ChatResponseBody;

      if (!res.ok) {
        throw new Error(data.error || `Assistant error (${res.status})`);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply || "...",
          actions: data.actions,
        },
      ]);
    } catch (err) {
      const description =
        err instanceof Error ? err.message : "Failed to reach the assistant.";
      // Restore the unsent draft so the operator can retry without retyping.
      setDraft(message);
      setMessages((prev) => prev.slice(0, -1));
      toast({
        title: "Assistant unavailable",
        description,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }, [draft, sending, messages, groupId, toast]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          Chat with your assistant
        </CardTitle>
        <CardDescription>
          You are chatting as an admin, so the assistant answers with full
          knowledge-graph scope and can operate this group&apos;s connectors on
          your behalf. Ask it about the group or tell it to act.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={scrollRef}
          className="h-72 overflow-y-auto rounded-md border bg-muted/30 p-3 space-y-3"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Bot className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No messages yet. Say hello to your group&apos;s assistant.
              </p>
            </div>
          ) : (
            messages.map((entry, index) => (
              <div
                key={index}
                className={`flex gap-2 ${
                  entry.role === "user" ? "flex-row-reverse" : "flex-row"
                }`}
              >
                <div className="mt-0.5 shrink-0 rounded-full bg-background p-1.5 border">
                  {entry.role === "user" ? (
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  )}
                </div>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    entry.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-background border"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">
                    {entry.content}
                  </p>
                  {entry.actions && entry.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.actions.map((action, actionIndex) => (
                        <Badge
                          key={actionIndex}
                          variant={action.ok ? "secondary" : "destructive"}
                          className="text-[10px] gap-1"
                        >
                          <Wrench className="h-3 w-3" />
                          {action.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {sending && (
            <div className="flex gap-2">
              <div className="mt-0.5 shrink-0 rounded-full bg-background p-1.5 border">
                <Bot className="h-3.5 w-3.5 text-primary" />
              </div>
              <div className="rounded-lg border bg-background px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Ask your assistant something, or tell it to act..."
            className="flex-1 resize-none"
            disabled={sending}
          />
          <Button
            type="button"
            size="icon"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            title="Send"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default GroupAssistantChat;
