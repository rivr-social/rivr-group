/**
 * Virtual Meeting join lane for an event.
 *
 * GET  /api/events/[id]/meeting — meeting status (participants, joinable).
 * POST /api/events/[id]/meeting — join: ensures the deterministic room
 *   exists and returns a LiveKit token whose identity is the caller's
 *   authenticated agent id (which is what makes the recorded transcript
 *   speaker-correlated).
 *
 * Auth: resolveAuthenticatedUserId (session OR remote-viewer cookie —
 * bare auth() would lock out SSO-landed federated members). Electorate:
 * group manage access, an active membership (canPostToGroup), or an
 * active RSVP on the event. Join window enforced for non-managers.
 */

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import {
  resolveAuthenticatedUserId,
  hasGroupManageAccess,
  canPostToGroup,
} from "@/app/actions/resource-creation/helpers";
import { hasActiveEventRsvp } from "@/app/actions/interactions/events-jobs";
import {
  getLiveKitConfig,
  isMeetingRecordingConfigured,
  createRoom,
  generateToken,
  listParticipants,
} from "@/lib/meetings/livekit";
import {
  MEETING_KIND_VIRTUAL,
  MEETING_STATUS,
  META_MEETING_CREATED_AT,
  META_MEETING_CREATED_BY,
  META_MEETING_ROOM,
  ERROR_EVENT_NOT_FOUND,
  ERROR_FORBIDDEN,
  ERROR_LIVEKIT_NOT_CONFIGURED,
  ERROR_NOT_VIRTUAL_MEETING,
  ERROR_OUTSIDE_JOIN_WINDOW,
  ERROR_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
  STATUS_SERVICE_UNAVAILABLE,
  STATUS_UNAUTHORIZED,
  STATUS_UNPROCESSABLE,
  eventRoomName,
} from "@/lib/meetings/constants";
import { isWithinJoinWindow } from "@/lib/meetings/event-window";
import { patchEventMetadata } from "@/lib/meetings/transcript-land";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadVirtualMeetingEvent(eventId: string) {
  const [event] = await db
    .select({
      id: resources.id,
      name: resources.name,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, eventId),
        eq(resources.type, "event"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!event) return null;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const groupId =
    typeof metadata.groupId === "string" && metadata.groupId.trim()
      ? metadata.groupId
      : event.ownerId;

  return { event, metadata, groupId };
}

async function resolveMeetingAccess(
  userId: string,
  eventId: string,
  groupId: string,
): Promise<{ allowed: boolean; isManager: boolean }> {
  const isManager = await hasGroupManageAccess(userId, groupId).catch(() => false);
  if (isManager) return { allowed: true, isManager: true };

  const [isMember, hasRsvp] = await Promise.all([
    canPostToGroup(userId, groupId, "create").catch(() => false),
    hasActiveEventRsvp(userId, eventId).catch(() => false),
  ]);
  return { allowed: isMember || hasRsvp, isManager: false };
}

export async function GET(_request: Request, context: RouteContext) {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: ERROR_UNAUTHORIZED },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const { id } = await context.params;
  const loaded = await loadVirtualMeetingEvent(id);
  if (!loaded) {
    return NextResponse.json(
      { error: ERROR_EVENT_NOT_FOUND },
      { status: STATUS_NOT_FOUND },
    );
  }

  const config = getLiveKitConfig();
  if (!config) {
    return NextResponse.json(
      { error: ERROR_LIVEKIT_NOT_CONFIGURED },
      { status: STATUS_SERVICE_UNAVAILABLE },
    );
  }

  const { metadata, groupId } = loaded;
  const roomName =
    typeof metadata[META_MEETING_ROOM] === "string"
      ? (metadata[META_MEETING_ROOM] as string)
      : null;

  let numParticipants = 0;
  if (roomName) {
    try {
      numParticipants = (await listParticipants(config, roomName)).length;
    } catch {
      numParticipants = 0; // room not live right now
    }
  }

  const access = await resolveMeetingAccess(userId, id, groupId);
  const withinWindow = isWithinJoinWindow(metadata, Date.now());

  return NextResponse.json({
    isVirtualMeeting: metadata.meetingKind === MEETING_KIND_VIRTUAL,
    status:
      numParticipants > 0 ? MEETING_STATUS.ACTIVE : MEETING_STATUS.SCHEDULED,
    numParticipants,
    canJoin: access.allowed && (access.isManager || withinWindow),
    withinWindow,
    recordingEnabled:
      metadata.transcriptionEnabled !== false && isMeetingRecordingConfigured(),
  });
}

export async function POST(_request: Request, context: RouteContext) {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: ERROR_UNAUTHORIZED },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const config = getLiveKitConfig();
  if (!config) {
    return NextResponse.json(
      { error: ERROR_LIVEKIT_NOT_CONFIGURED },
      { status: STATUS_SERVICE_UNAVAILABLE },
    );
  }

  const { id } = await context.params;
  const loaded = await loadVirtualMeetingEvent(id);
  if (!loaded) {
    return NextResponse.json(
      { error: ERROR_EVENT_NOT_FOUND },
      { status: STATUS_NOT_FOUND },
    );
  }

  const { event, metadata, groupId } = loaded;
  if (metadata.meetingKind !== MEETING_KIND_VIRTUAL) {
    return NextResponse.json(
      { error: ERROR_NOT_VIRTUAL_MEETING },
      { status: STATUS_UNPROCESSABLE },
    );
  }

  const access = await resolveMeetingAccess(userId, id, groupId);
  if (!access.allowed) {
    return NextResponse.json(
      { error: ERROR_FORBIDDEN },
      { status: STATUS_FORBIDDEN },
    );
  }
  if (!access.isManager && !isWithinJoinWindow(metadata, Date.now())) {
    return NextResponse.json(
      { error: ERROR_OUTSIDE_JOIN_WINDOW },
      { status: STATUS_FORBIDDEN },
    );
  }

  const [agentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);
  const displayName = agentRow?.name?.trim() || "Participant";

  const roomName = eventRoomName(id);
  try {
    // Idempotent: createRoom returns the existing room when it's already up.
    await createRoom(config, {
      roomName,
      metadata: JSON.stringify({ eventId: id, eventName: event.name }),
    });

    const token = await generateToken(config, {
      roomName,
      identity: userId,
      name: displayName,
    });

    // Live-state stamp only (who opened the room, when) — mirrors the person
    // app's precedent; the event's federated content fields are untouched.
    if (metadata[META_MEETING_ROOM] !== roomName) {
      await patchEventMetadata(id, {
        [META_MEETING_ROOM]: roomName,
        [META_MEETING_CREATED_AT]: new Date().toISOString(),
        [META_MEETING_CREATED_BY]: userId,
      });
    }

    return NextResponse.json(
      {
        roomName,
        token,
        url: config.url,
        identity: userId,
        displayName,
        recordingEnabled:
          metadata.transcriptionEnabled !== false &&
          isMeetingRecordingConfigured(),
      },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to join the meeting";
    console.error("Virtual meeting join error:", message);
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
