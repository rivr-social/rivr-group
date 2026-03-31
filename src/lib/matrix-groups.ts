"use server";

/**
 * Server-side Matrix group room management.
 *
 * Purpose:
 * - Create and manage Matrix rooms for group agents.
 * - Invite/remove members from group Matrix rooms.
 * - Toggle chat mode (ledger, matrix, both) for groups.
 *
 * Key exports:
 * - `createGroupMatrixRoom` — creates a Matrix room and links it to a group agent.
 * - `inviteToGroupRoom` — invites a user to a group's Matrix room.
 * - `removeFromGroupRoom` — kicks a user from a group's Matrix room.
 * - `setGroupChatMode` — updates the chat mode for a group's Matrix room.
 * - `getGroupMatrixRoom` — fetches the Matrix room record for a group.
 *
 * Dependencies:
 * - `@/lib/env` for Matrix configuration.
 * - `@/db` for group_matrix_rooms table operations.
 * - `@/db/schema` for table definitions.
 */
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db } from "@/db";
import { agents, groupMatrixRooms, type ChatMode } from "@/db/schema";

/**
 * Makes an authenticated request to the Synapse Admin API.
 */
async function synapseAdminRequest(path: string, options: RequestInit = {}) {
  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  const response = await fetch(`${homeserverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Synapse admin API error: ${response.status} - ${JSON.stringify(error)}`
    );
  }

  return response.json();
}

/**
 * Creates a Matrix room for a group and stores the mapping in group_matrix_rooms.
 *
 * The room is created via the Synapse Admin API as a public group chat.
 * The group's owner (creator) is set as the room admin.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.groupName - Display name for the room
 * @param params.creatorMatrixUserId - Matrix user ID of the group creator
 * @param params.chatMode - Initial chat mode (default: "both")
 * @returns The Matrix room ID and the database record ID
 */
export async function createGroupMatrixRoom(params: {
  groupAgentId: string;
  groupName: string;
  creatorMatrixUserId: string;
  chatMode?: ChatMode;
}): Promise<{ matrixRoomId: string; recordId: string }> {
  // Check if room already exists for this group
  const existing = await db.query.groupMatrixRooms.findFirst({
    where: eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
  });

  if (existing) {
    return { matrixRoomId: existing.matrixRoomId, recordId: existing.id };
  }

  // Create room via Synapse Admin API
  const result = await synapseAdminRequest("/_synapse/admin/v1/rooms", {
    method: "POST",
    body: JSON.stringify({
      creator: params.creatorMatrixUserId,
      name: params.groupName,
      topic: `Group chat for ${params.groupName}`,
      preset: "private_chat",
      room_alias_name: `group-${params.groupAgentId.replace(/-/g, "")}`,
    }),
  });

  const matrixRoomId: string = result.room_id;

  // Store the mapping
  const [record] = await db
    .insert(groupMatrixRooms)
    .values({
      groupAgentId: params.groupAgentId,
      matrixRoomId,
      chatMode: params.chatMode ?? "both",
    })
    .returning({ id: groupMatrixRooms.id });

  return { matrixRoomId, recordId: record.id };
}

/**
 * Invites a user to a group's Matrix room.
 *
 * Looks up both the group's Matrix room and the target user's Matrix ID,
 * then sends an invite via the Synapse Admin API.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.targetAgentId - UUID of the user agent to invite
 */
export async function inviteToGroupRoom(params: {
  groupAgentId: string;
  targetAgentId: string;
}): Promise<void> {
  const groupRoom = await db.query.groupMatrixRooms.findFirst({
    where: eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
  });

  if (!groupRoom) {
    throw new Error(`No Matrix room found for group ${params.groupAgentId}`);
  }

  const targetAgent = await db.query.agents.findFirst({
    where: eq(agents.id, params.targetAgentId),
    columns: { matrixUserId: true },
  });

  if (!targetAgent?.matrixUserId) {
    throw new Error(
      `Target agent ${params.targetAgentId} has no Matrix account`
    );
  }

  // Invite via Synapse Admin API
  await synapseAdminRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(groupRoom.matrixRoomId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: targetAgent.matrixUserId,
      }),
    }
  );
}

/**
 * Removes a user from a group's Matrix room by kicking them.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.targetAgentId - UUID of the user agent to remove
 */
export async function removeFromGroupRoom(params: {
  groupAgentId: string;
  targetAgentId: string;
}): Promise<void> {
  const groupRoom = await db.query.groupMatrixRooms.findFirst({
    where: eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
  });

  if (!groupRoom) return; // No room to remove from

  const targetAgent = await db.query.agents.findFirst({
    where: eq(agents.id, params.targetAgentId),
    columns: { matrixUserId: true },
  });

  if (!targetAgent?.matrixUserId) return; // No Matrix account to remove

  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  // Use the standard Matrix API with admin token to kick the user
  await fetch(
    `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(groupRoom.matrixRoomId)}/kick`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        user_id: targetAgent.matrixUserId,
        reason: "Removed from group",
      }),
    }
  );
}

/**
 * Updates the chat mode for a group's Matrix room.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.chatMode - New chat mode ("ledger", "matrix", or "both")
 */
export async function setGroupChatMode(params: {
  groupAgentId: string;
  chatMode: ChatMode;
}): Promise<void> {
  await db
    .update(groupMatrixRooms)
    .set({
      chatMode: params.chatMode,
      updatedAt: new Date(),
    })
    .where(eq(groupMatrixRooms.groupAgentId, params.groupAgentId));
}

/**
 * Fetches the Matrix room record for a group agent.
 *
 * @param groupAgentId - UUID of the group agent
 * @returns The group Matrix room record, or null if none exists
 */
export async function getGroupMatrixRoom(groupAgentId: string) {
  return db.query.groupMatrixRooms.findFirst({
    where: eq(groupMatrixRooms.groupAgentId, groupAgentId),
  }) ?? null;
}
