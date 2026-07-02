"use server";

/**
 * Server-side Matrix Synapse Admin API client.
 *
 * Purpose:
 * - Provision and manage Matrix user accounts via Synapse Admin API v2.
 * - Create DM rooms between provisioned users.
 * - Update profile metadata (display name, avatar) for Matrix accounts.
 *
 * Key exports:
 * - `provisionMatrixUser` — registers a new Matrix user and obtains an access token.
 * - `deactivateMatrixUser` — deactivates a Matrix user account.
 * - `updateMatrixProfile` — updates display name and/or avatar for a Matrix user.
 * - `getRoomMembers` — lists the canonical member Matrix user IDs of a room.
 * - `createDirectMessageRoom` — creates a DM room between two Matrix users.
 *
 * Dependencies:
 * - `@/lib/env` for `MATRIX_HOMESERVER_URL`, `MATRIX_ADMIN_TOKEN`, `MATRIX_SERVER_NAME`.
 */
import { getEnv } from "@/lib/env";

/**
 * Makes an authenticated request to the Synapse Admin API.
 *
 * @param path - API path (e.g. `/_synapse/admin/v2/users/...`)
 * @param options - Standard fetch options
 * @returns Parsed JSON response body
 * @throws Error if the response status is not OK
 */
async function synapseAdminRequest(path: string, options: RequestInit = {}) {
  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  const response = await fetch(`${homeserverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminToken}`,
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
 * Provisions a new Matrix user via the Synapse Admin API v2.
 *
 * Uses PUT /_synapse/admin/v2/users/{userId} to create or update the user,
 * then POST /_synapse/admin/v1/users/{userId}/login to obtain an access token.
 *
 * @param params.localpart - Username portion (no @ prefix, no :server suffix)
 * @param params.displayName - Display name for the Matrix profile
 * @param params.avatarUrl - Optional mxc:// avatar URL
 * @returns The full Matrix user ID and an access token for client-side use
 */
export async function provisionMatrixUser(params: {
  localpart: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<{ matrixUserId: string; accessToken: string }> {
  const serverName = getEnv("MATRIX_SERVER_NAME");
  const matrixUserId = `@${params.localpart}:${serverName}`;

  // Register user via admin API v2
  await synapseAdminRequest(
    `/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        displayname: params.displayName,
        admin: false,
        deactivated: false,
      }),
    }
  );

  // Get access token for the user
  const loginResult = await synapseAdminRequest(
    `/_synapse/admin/v1/users/${encodeURIComponent(matrixUserId)}/login`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );

  return {
    matrixUserId,
    accessToken: loginResult.access_token,
  };
}

/**
 * Deactivates a Matrix user account via the Synapse Admin API.
 *
 * @param matrixUserId - Full Matrix user ID (e.g. `@user:server.name`)
 */
export async function deactivateMatrixUser(matrixUserId: string): Promise<void> {
  await synapseAdminRequest(
    `/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ deactivated: true }),
    }
  );
}

/**
 * Updates the Matrix profile for a user (display name and/or avatar).
 *
 * @param params.matrixUserId - Full Matrix user ID
 * @param params.displayName - New display name (optional)
 * @param params.avatarUrl - New mxc:// avatar URL (optional)
 */
export async function updateMatrixProfile(params: {
  matrixUserId: string;
  displayName?: string;
  avatarUrl?: string;
}): Promise<void> {
  const updates: Record<string, string> = {};
  if (params.displayName) updates.displayname = params.displayName;
  if (params.avatarUrl) updates.avatar_url = params.avatarUrl;

  if (Object.keys(updates).length > 0) {
    await synapseAdminRequest(
      `/_synapse/admin/v2/users/${encodeURIComponent(params.matrixUserId)}`,
      {
        method: "PUT",
        body: JSON.stringify(updates),
      }
    );
  }
}

/**
 * Force-joins a Matrix user into a room via the Synapse Admin API.
 * Used to auto-accept DM invitations so both parties see the room immediately.
 *
 * @param params.userId - Full Matrix user ID to join into the room
 * @param params.roomId - The Matrix room ID to join
 */
export async function adminJoinRoom(params: {
  userId: string;
  roomId: string;
}): Promise<void> {
  await synapseAdminRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(params.roomId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
      }),
    }
  );
}

/**
 * Lists the current member Matrix user IDs of a room via the Synapse Admin API.
 *
 * This is the CANONICAL membership view (server-side, admin-token authority) —
 * unlike any client-supplied or mirrored participant list. Used by the
 * room-membership authorization gate to verify that a caller is an actual
 * member of a direct room before letting them force-join others (EVT-SEC-001).
 *
 * @param roomId - The Matrix room ID (must start with `!`)
 * @returns The list of joined/known member Matrix user IDs, or `[]` on an
 *          unexpected response shape.
 * @throws Error if the roomId is malformed or the admin API call fails.
 */
export async function getRoomMembers(roomId: string): Promise<string[]> {
  if (!roomId.startsWith("!")) {
    throw new Error(`Invalid Matrix roomId: ${roomId}`);
  }
  const result = await synapseAdminRequest(
    `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`,
    { method: "GET" },
  );
  const members = (result?.members as unknown) ?? [];
  if (!Array.isArray(members)) return [];
  return members.filter((m): m is string => typeof m === "string");
}

/**
 * Obtains a short-lived access token for a Matrix user via the Synapse admin
 * login endpoint (`POST /_synapse/admin/v1/users/{userId}/login`). Used to
 * perform client-server API calls ON BEHALF OF a user when we don't hold
 * their persisted token — e.g. server-side room creation.
 */
async function obtainUserAccessToken(matrixUserId: string): Promise<string> {
  const loginResult = await synapseAdminRequest(
    `/_synapse/admin/v1/users/${encodeURIComponent(matrixUserId)}/login`,
    {
      method: "POST",
      // Expire the impersonation token quickly — it exists only for this call.
      body: JSON.stringify({ valid_until_ms: Date.now() + 5 * 60_000 }),
    },
  );
  const accessToken = loginResult?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(`Synapse admin /login returned no access_token for ${matrixUserId}`);
  }
  return accessToken;
}

/**
 * Creates a Matrix room ON BEHALF OF a user via the client-server API.
 *
 * Synapse has NO admin endpoint for room creation — `POST /_synapse/admin/v1/rooms`
 * does not exist and returns `405 M_UNRECOGNIZED` (the admin rooms API is
 * list/detail/delete only). The correct server-side pattern is: mint a
 * short-lived token for the creator via the admin login endpoint, then call
 * `POST /_matrix/client/v3/createRoom` as that user.
 *
 * @returns The newly created Matrix room ID
 */
export async function createRoomAsUser(params: {
  creatorUserId: string;
  name?: string;
  topic?: string;
  preset?: "private_chat" | "trusted_private_chat" | "public_chat";
  roomAliasName?: string;
  invite?: string[];
  isDirect?: boolean;
}): Promise<{ roomId: string }> {
  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const accessToken = await obtainUserAccessToken(params.creatorUserId);

  const response = await fetch(`${homeserverUrl}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      preset: params.preset ?? "private_chat",
      is_direct: params.isDirect ?? false,
      ...(params.name ? { name: params.name } : {}),
      ...(params.topic ? { topic: params.topic } : {}),
      ...(params.roomAliasName ? { room_alias_name: params.roomAliasName } : {}),
      ...(params.invite && params.invite.length > 0 ? { invite: params.invite } : {}),
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Matrix createRoom error: ${response.status} - ${JSON.stringify(error)}`,
    );
  }

  const result = await response.json();
  const roomId = result?.room_id;
  if (typeof roomId !== "string" || !roomId.startsWith("!")) {
    throw new Error(`Matrix createRoom returned no room_id for ${params.creatorUserId}`);
  }
  return { roomId };
}

/**
 * Creates a direct message room between two Matrix users via Synapse Admin API.
 *
 * @param params.inviterUserId - Full Matrix user ID of the room creator
 * @param params.inviteeUserId - Full Matrix user ID of the invited user
 * @returns The Matrix room ID for the new DM room
 */
export async function createDirectMessageRoom(params: {
  inviterUserId: string;
  inviteeUserId: string;
}): Promise<{ roomId: string }> {
  return createRoomAsUser({
    creatorUserId: params.inviterUserId,
    invite: [params.inviteeUserId],
    isDirect: true,
    preset: "trusted_private_chat",
  });
}
