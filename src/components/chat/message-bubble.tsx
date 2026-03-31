"use client";

interface MessageBubbleProps {
  body: string;
  timestamp: number;
  isCurrentUser: boolean;
  senderName?: string;
}

function formatMessageTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageBubble({
  body,
  timestamp,
  isCurrentUser,
  senderName,
}: MessageBubbleProps) {
  return (
    <div
      className={`flex ${isCurrentUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isCurrentUser
            ? "bg-primary text-primary-foreground rounded-br-none"
            : "bg-muted rounded-bl-none"
        }`}
      >
        {!isCurrentUser && senderName && (
          <p className="text-xs font-medium mb-1 opacity-80">{senderName}</p>
        )}
        <p className="whitespace-pre-wrap break-words">{body}</p>
        <p className="text-xs mt-1 opacity-70">{formatMessageTime(timestamp)}</p>
      </div>
    </div>
  );
}
