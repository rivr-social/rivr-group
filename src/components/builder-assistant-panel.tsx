"use client";

/**
 * BuilderAssistantPanel — chat-with-tools surface inside `/builder`.
 *
 * The operator describes a change ("make the hero teal", "add a donations
 * page", "publish it"); the server route runs the workspace-jailed tool loop
 * and returns the assistant's reply plus which files it touched and whether
 * it published. All model/tool work is server-side (`/api/builder/assistant`)
 * — this panel is a thin transcript + input.
 */

import { useCallback, useRef, useState } from "react";
import { Bot, Loader2, Send, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const API_ASSISTANT = "/api/builder/assistant";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  /** Files the assistant wrote/deleted during this turn (activity trail). */
  changedPaths?: string[];
  /** Version number when this turn published. */
  publishedVersion?: number | null;
}

export function BuilderAssistantPanel({
  targetAgentId,
  ownerLabel,
  onPublished,
}: {
  targetAgentId?: string;
  ownerLabel?: string | null;
  /** Called after the assistant publishes, so the parent refreshes state. */
  onPublished?: (publication: unknown) => void;
}) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    setError("");
    setInput("");
    setBusy(true);
    const history = entries.map(({ role, content }) => ({ role, content }));
    setEntries((prev) => [...prev, { role: "user", content: message }]);
    try {
      const res = await fetch(API_ASSISTANT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, targetAgentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Assistant request failed");
      const publication = data.publication as { publishedVersionNumber?: number | null } | null;
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: typeof data.reply === "string" ? data.reply : "(no reply)",
          changedPaths: Array.isArray(data.changedPaths) ? data.changedPaths : [],
          publishedVersion: data.published
            ? (publication?.publishedVersionNumber ?? null)
            : null,
        },
      ]);
      if (data.published && onPublished) onPublished(data.publication);
      queueMicrotask(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assistant request failed");
    } finally {
      setBusy(false);
    }
  }, [busy, entries, input, targetAgentId, onPublished]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Assistant
        </CardTitle>
        <CardDescription>
          Ask for changes in plain language — it edits the site files and, when you say so,
          publishes{ownerLabel ? ` ${ownerLabel}'s site` : " your site"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.length > 0 && (
          <div ref={scrollRef} className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {entries.map((entry, i) => (
              <div key={i} className="text-sm">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {entry.role === "assistant" ? <Bot className="h-3 w-3" /> : null}
                  {entry.role === "assistant" ? "Assistant" : "You"}
                </div>
                <div className="whitespace-pre-wrap">{entry.content}</div>
                {entry.changedPaths && entry.changedPaths.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {[...new Set(entry.changedPaths)].map((path) => (
                      <Badge key={path} variant="outline" className="text-[10px] font-mono">
                        ✎ {path}
                      </Badge>
                    ))}
                  </div>
                )}
                {entry.publishedVersion != null && (
                  <Badge className="mt-1 text-[10px]">Published v{entry.publishedVersion}</Badge>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder='e.g. "Make the hero section teal and add a donations page — then publish."'
            rows={2}
            disabled={busy}
            className="text-sm"
          />
          <Button size="icon" onClick={send} disabled={busy || !input.trim()} aria-label="Send">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Edits are applied to the site workspace and only go live when the assistant publishes
          — ask it to publish explicitly.
        </p>
        {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
      </CardContent>
    </Card>
  );
}
