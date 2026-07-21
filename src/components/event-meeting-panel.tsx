"use client";

/**
 * Virtual Meeting panel for an event page.
 *
 * Shows the meeting state (scheduled/live, participant count) and a Join
 * button; joining opens a full-screen LiveKit room (the event IS the
 * venue). When recording is enabled, participants are told the session
 * is recorded and that a speaker-labeled transcript will be attached to
 * the event afterward.
 */

import { useCallback, useEffect, useState } from "react";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import "@livekit/components-styles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CircleDot, Loader2, Video, X } from "lucide-react";

const STATUS_POLL_INTERVAL_MS = 30_000;

interface MeetingStatusResponse {
  isVirtualMeeting?: boolean;
  status?: "active" | "ended" | "scheduled";
  numParticipants?: number;
  canJoin?: boolean;
  withinWindow?: boolean;
  recordingEnabled?: boolean;
  error?: string;
}

interface JoinResponse {
  roomName?: string;
  token?: string;
  url?: string;
  recordingEnabled?: boolean;
  error?: string;
}

interface EventMeetingPanelProps {
  eventId: string;
  eventName: string;
}

export function EventMeetingPanel({ eventId, eventName }: EventMeetingPanelProps) {
  const [status, setStatus] = useState<MeetingStatusResponse | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{ token: string; url: string; recordingEnabled: boolean } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/meeting`);
      if (!response.ok) return;
      const data: MeetingStatusResponse = await response.json();
      setStatus(data);
    } catch {
      /* transient — next poll retries */
    }
  }, [eventId]);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const joinMeeting = useCallback(async () => {
    setJoining(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/meeting`,
        { method: "POST" },
      );
      const data: JoinResponse = await response.json();
      if (!response.ok || !data.token || !data.url) {
        setError(data.error || `Could not join the meeting (${response.status})`);
        return;
      }
      setSession({
        token: data.token,
        url: data.url,
        recordingEnabled: data.recordingEnabled === true,
      });
    } catch (joinError) {
      setError(
        joinError instanceof Error ? joinError.message : "Could not join the meeting",
      );
    } finally {
      setJoining(false);
    }
  }, [eventId]);

  const leaveMeeting = useCallback(() => {
    setSession(null);
    void refreshStatus();
  }, [refreshStatus]);

  // Full-screen room while joined.
  if (session) {
    return (
      <div className="fixed inset-0 z-[140] bg-background flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <Video className="h-4 w-4 flex-shrink-0" />
            <p className="text-sm font-semibold truncate">{eventName}</p>
            {session.recordingEnabled ? (
              <Badge variant="destructive" className="gap-1 text-[10px]">
                <CircleDot className="h-3 w-3" /> Recording
              </Badge>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={leaveMeeting} title="Leave meeting">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {session.recordingEnabled ? (
          <p className="px-4 py-1.5 text-[11px] text-muted-foreground border-b bg-muted/30">
            This meeting is recorded. A transcript with speaker names will be
            attached to the event afterward.
          </p>
        ) : null}
        <div className="flex-1 min-h-0" data-lk-theme="default">
          <LiveKitRoom
            token={session.token}
            serverUrl={session.url}
            connect
            audio
            video
            onDisconnected={leaveMeeting}
            style={{ height: "100%" }}
          >
            <VideoConference />
          </LiveKitRoom>
        </div>
      </div>
    );
  }

  const isLive = status?.status === "active" && (status?.numParticipants ?? 0) > 0;

  return (
    <Card className="border-primary/30">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 flex-shrink-0">
            <Video className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Virtual Meeting</p>
            <p className="text-xs text-muted-foreground">
              {isLive
                ? `Live now — ${status?.numParticipants} in the room`
                : status?.withinWindow
                  ? "The room is open"
                  : "Opens shortly before the event starts"}
              {status?.recordingEnabled
                ? " · recorded with transcript"
                : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">Live</Badge>
          ) : null}
          <Button
            onClick={() => void joinMeeting()}
            disabled={joining || status?.canJoin === false}
            title={
              status?.canJoin === false
                ? "Join opens near the event time for members and RSVPs"
                : undefined
            }
          >
            {joining ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Video className="mr-2 h-4 w-4" />
            )}
            Join meeting
          </Button>
        </div>
        {error ? (
          <p className="w-full text-xs text-destructive">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
