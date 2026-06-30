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
import { and, eq, isNull, or } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db } from "@/db";
import { agents, groupMatrixRooms, ledger, type ChatMode } from "@/db/schema";
import { provisionMatrixUser } from "@/lib/matrix-admin";

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

  // Self-heal: lazily provision the target's Matrix account if they have none
  // yet, so a freshly joined member can always be force-joined into the room.
  const targetMatrixUserId = await ensureAgentMatrixUserId(params.targetAgentId);
  if (!targetMatrixUserId) {
    throw new Error(
      `Could not resolve or provision a Matrix account for agent ${params.targetAgentId}`,
    );
  }

  // Invite via Synapse Admin API
  await synapseAdminRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(groupRoom.matrixRoomId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: targetMatrixUserId,
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

// ─── Idempotent provisioning + member self-heal (C1) ────────────────────────

/**
 * Ensures an agent has a Matrix user id, provisioning a local Matrix account on
 * demand if it has none. Returns the Matrix user id, or null when the agent is
 * missing or Synapse provisioning fails.
 *
 * Both credential columns are written together; a DB write failure clears the
 * partial state so a later retry re-provisions cleanly. A pre-existing
 * `matrixUserId` short-circuits without touching Synapse (force-join only needs
 * the user id, not a token).
 */
async function ensureAgentMatrixUserId(agentId: string): Promise<string | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { id: true, name: true, matrixUserId: true },
  });
  if (!agent) return null;

  if (typeof agent.matrixUserId === "string" && agent.matrixUserId.length > 0) {
    return agent.matrixUserId;
  }

  try {
    const localpart = agent.id.replace(/-/g, "");
    const result = await provisionMatrixUser({
      localpart,
      displayName: agent.name,
    });

    try {
      await db
        .update(agents)
        .set({
          matrixUserId: result.matrixUserId,
          matrixAccessToken: result.accessToken,
        })
        .where(eq(agents.id, agent.id));
    } catch (dbError) {
      console.error(
        "[matrix] ensureAgentMatrixUserId: DB write of credentials failed; clearing partial state for agent:",
        agentId,
        dbError,
      );
      await db
        .update(agents)
        .set({ matrixUserId: null, matrixAccessToken: null })
        .where(eq(agents.id, agent.id))
        .catch((rollbackError) => {
          console.error(
            "[matrix] ensureAgentMatrixUserId: rollback of partial state also failed for agent:",
            agentId,
            rollbackError,
          );
        });
      return null;
    }

    return result.matrixUserId;
  } catch (error) {
    console.error(
      "[matrix] ensureAgentMatrixUserId: provisioning failed for agent:",
      agentId,
      error,
    );
    return null;
  }
}

/**
 * Resolves an agent id suitable to be the creator/admin of a group's Matrix
 * room. Prefers the `own` edge (the creator), then any active admin/moderator
 * membership edge, then the legacy `metadata.creatorId`. Returns null when no
 * responsible agent can be found.
 */
async function resolveGroupRoomCreatorAgentId(groupAgentId: string): Promise<string | null> {
  const ownerEdge = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.objectId, groupAgentId),
      eq(ledger.verb, "own"),
      eq(ledger.isActive, true),
    ),
    columns: { subjectId: true },
  });
  if (ownerEdge?.subjectId) return ownerEdge.subjectId;

  const adminEdge = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.objectId, groupAgentId),
      eq(ledger.isActive, true),
      or(eq(ledger.verb, "join"), eq(ledger.verb, "belong")),
      or(eq(ledger.role, "admin"), eq(ledger.role, "moderator")),
    ),
    columns: { subjectId: true },
  });
  if (adminEdge?.subjectId) return adminEdge.subjectId;

  const group = await db.query.agents.findFirst({
    where: eq(agents.id, groupAgentId),
    columns: { metadata: true },
  });
  const metadata = (group?.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.creatorId === "string" && metadata.creatorId.length > 0) {
    return metadata.creatorId;
  }

  return null;
}

/**
 * Idempotently guarantees a group has a live Matrix room, provisioning lazily.
 *
 * Unlike {@link createGroupMatrixRoom} (which requires a ready-made
 * `creatorMatrixUserId`), this resolves the group's creator/admin agent and
 * lazily provisions that agent's Matrix account on demand — so a group whose
 * creator never had a Matrix identity still gets a room. Safe to call on every
 * group create and every join: if a live room already exists it is returned
 * without touching Synapse.
 *
 * @param groupAgentId - UUID of the group agent
 * @returns The live room mapping, or null when the group is missing or no
 *   responsible agent could be provisioned (reasons are logged).
 */
export async function ensureGroupMatrixRoom(
  groupAgentId: string,
): Promise<{ matrixRoomId: string; recordId: string } | null> {
  const existing = await getGroupMatrixRoom(groupAgentId);
  if (existing) {
    return { matrixRoomId: existing.matrixRoomId, recordId: existing.id };
  }

  const group = await db.query.agents.findFirst({
    where: and(eq(agents.id, groupAgentId), isNull(agents.deletedAt)),
    columns: { id: true, name: true },
  });
  if (!group) {
    console.error(
      `[matrix] ensureGroupMatrixRoom: group agent ${groupAgentId} not found; skipping room provisioning`,
    );
    return null;
  }

  const creatorAgentId = await resolveGroupRoomCreatorAgentId(groupAgentId);
  if (!creatorAgentId) {
    console.error(
      `[matrix] ensureGroupMatrixRoom: no creator/admin resolvable for group ${groupAgentId}; skipping`,
    );
    return null;
  }

  // Lazily provision the creator's Matrix account if they have none yet. This
  // is the key difference from the old guard that bailed when matrixUserId was
  // null — every group now gets a room regardless of creator provisioning.
  const creatorMatrixUserId = await ensureAgentMatrixUserId(creatorAgentId);
  if (!creatorMatrixUserId) {
    console.error(
      `[matrix] ensureGroupMatrixRoom: could not provision Matrix account for creator ${creatorAgentId} of group ${groupAgentId}`,
    );
    return null;
  }

  return createGroupMatrixRoom({
    groupAgentId,
    groupName: group.name,
    creatorMatrixUserId,
  });
}
