"use server";

/**
 * Matrix server actions for authenticated Matrix chat operations.
 *
 * SECURITY (EVT-SEC-001): every export in a `"use server"` module is a
 * client-reachable server action, so each one must be safe to call with
 * fully attacker-controlled arguments. The principal is ALWAYS derived from
 * `auth()` — never from a client-supplied id. Concretely:
 *  - Read actions are session-scoped (own credentials) or return only
 *    non-secret identifiers.
 *  - The membership-mutating action (`ensureUserJoinedRoom`) is gated by
 *    `canActorMutateRoomMembership`, which derives authority from the canonical
 *    ledger (group admin) or canonical Synapse membership (direct rooms) — never
 *    from a client-supplied claim. Without this, any authenticated client could
 *    force any Matrix user into any room.
 *  - The privileged credential provisioner (`ensureAgentMatrixIdentity`) is a
 *    private, non-exported helper and returns only the Matrix user id (never an
 *    access token), so it is not a client-reachable token oracle.
 *
 * Purpose:
 * - Provide authenticated access to Matrix credentials for the current user.
 * - Look up Matrix user IDs for DM targeting.
 *
 * Key exports:
 * - `getMatrixCredentials` — returns the current user's Matrix credentials.
 * - `getDmRoomForUser` — returns the target user's Matrix user ID for DM creation.
 *
 * Dependencies:
 * - `@/auth` for session authentication.
 * - `@/db` for database queries.
 * - `@/db/schema` for the agents table.
 */
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources, ledger, groupMatrixRooms } from "@/db/schema";
import { eq, and, or, gt, isNull, inArray } from "drizzle-orm";
import { adminJoinRoom, getRoomMembers } from "@/lib/matrix-admin";
import { provisionMatrixUser } from "@/lib/matrix-admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-box";

async function ensureAgentMatrixIdentity(agentId: string): Promise<string | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: {
      id: true,
      name: true,
      email: true,
      matrixUserId: true,
      matrixAccessToken: true,
    },
  });

  if (!agent) return null;
  if (agent.matrixUserId && agent.matrixAccessToken) return agent.matrixUserId;

  try {
    const localpart = agent.id.replace(/-/g, "");
    const result = await provisionMatrixUser({
      localpart,
      displayName: agent.name,
    });

    await db
      .update(agents)
      .set({
        matrixUserId: result.matrixUserId,
        // Encrypt the access token at rest (EVT-SEC-006). The userId is a
        // non-secret identifier and stays plaintext.
        matrixAccessToken: encryptSecret(result.accessToken),
      })
      .where(eq(agents.id, agent.id));

    return result.matrixUserId;
  } catch (error) {
    console.error("[matrix] Failed to provision Matrix identity for agent:", agentId, error);
    return null;
  }
}

/**
 * Retrieves Matrix credentials for the currently authenticated user.
 *
 * @returns Matrix userId, accessToken, and homeserverUrl, or null if not authenticated
 *          or if the user has no Matrix credentials provisioned.
 */
export async function getMatrixCredentials(): Promise<{
  userId: string;
  accessToken: string;
  homeserverUrl: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, session.user.id),
    columns: {
      id: true,
      matrixUserId: true,
      matrixAccessToken: true,
    },
  });

  if (!agent) return null;

  let matrixUserId = agent.matrixUserId;
  let matrixAccessToken = agent.matrixAccessToken;

  if (!matrixUserId || !matrixAccessToken) {
    matrixUserId = await ensureAgentMatrixIdentity(agent.id);
    if (!matrixUserId) return null;

    const refreshed = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
      columns: {
        matrixAccessToken: true,
      },
    });
    matrixAccessToken = refreshed?.matrixAccessToken ?? null;
  }

  if (!matrixUserId || !matrixAccessToken) return null;

  // The token is encrypted at rest (EVT-SEC-006); decrypt before handing it to
  // the browser matrix-js-sdk client. Legacy plaintext rows pass through.
  const decryptedAccessToken = decryptSecret(matrixAccessToken);
  if (!decryptedAccessToken) return null;

  return {
    userId: matrixUserId,
    accessToken: decryptedAccessToken,
    homeserverUrl: process.env.NEXT_PUBLIC_MATRIX_HOMESERVER_URL || "",
  };
}

/**
 * Looks up the Matrix user ID for a target agent, used for initiating DMs.
 *
 * @param targetAgentId - The UUID of the agent to look up
 * @returns The target agent's Matrix user ID, or null if not found or not provisioned.
 */
export async function getDmRoomForUser(targetAgentId: string): Promise<{
  targetMatrixUserId: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const matrixUserId = await ensureAgentMatrixIdentity(targetAgentId);
  if (!matrixUserId) return null;

  return {
    targetMatrixUserId: matrixUserId,
  };
}

/**
 * Looks up Matrix user IDs for multiple target agents.
 * Used for creating group DM rooms with multiple participants.
 *
 * @param targetAgentIds - Array of agent UUIDs to look up
 * @returns Array of Matrix user IDs for agents that have Matrix credentials provisioned.
 */
export async function getMatrixUserIdsForAgents(
  targetAgentIds: string[]
): Promise<string[]> {
  const session = await auth();
  if (!session?.user?.id) return [];
  if (targetAgentIds.length === 0) return [];

  // Cap to prevent unbounded concurrent identity provisioning requests.
  const MAX_MATRIX_AGENT_IDS = 50;
  const cappedIds = targetAgentIds.slice(0, MAX_MATRIX_AGENT_IDS);

  const matrixUserIds = await Promise.all(cappedIds.map((agentId) => ensureAgentMatrixIdentity(agentId)));
  return matrixUserIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Verified-principal group-admin check for a Matrix group room.
 *
 * Mirrors this app's own group-room authority model
 * (`resolveGroupRoomCreatorAgentId` in `@/lib/matrix-groups`): an actor holds
 * admin authority over a group when they have the `own` ledger edge, an active
 * admin/moderator membership edge (`join`/`belong`), or are the group agent's
 * recorded `metadata.creatorId`. Authority is derived ENTIRELY from canonical
 * server-side state — never from a client-supplied claim (EVT-SEC-001).
 */
async function isGroupRoomAdmin(actorId: string, groupAgentId: string): Promise<boolean> {
  const now = new Date();

  const ownerEdge = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, actorId),
      eq(ledger.objectId, groupAgentId),
      eq(ledger.verb, "own"),
      eq(ledger.isActive, true),
      or(isNull(ledger.expiresAt), gt(ledger.expiresAt, now)),
    ),
    columns: { id: true },
  });
  if (ownerEdge) return true;

  const adminEdge = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, actorId),
      eq(ledger.objectId, groupAgentId),
      eq(ledger.isActive, true),
      or(eq(ledger.verb, "join"), eq(ledger.verb, "belong")),
      or(eq(ledger.role, "admin"), eq(ledger.role, "moderator")),
      or(isNull(ledger.expiresAt), gt(ledger.expiresAt, now)),
    ),
    columns: { id: true },
  });
  if (adminEdge) return true;

  const group = await db.query.agents.findFirst({
    where: eq(agents.id, groupAgentId),
    columns: { metadata: true },
  });
  const metadata = (group?.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.creatorId === "string" && metadata.creatorId === actorId;
}

/**
 * Verified-principal authorization for mutating a Matrix room's membership
 * (force-joining a user). Authority is derived from CANONICAL sources ONLY —
 * never from a client-supplied claim (EVT-SEC-001):
 *  - Group rooms: checked FIRST. The actor must hold an admin/moderator/owner
 *    edge in the ledger for the owning group (`isGroupRoomAdmin`).
 *  - Direct rooms: the actor must be an actual Synapse member of the room,
 *    verified against the admin `getRoomMembers` view and matched by the actor's
 *    own provisioned Matrix user id.
 */
async function canActorMutateRoomMembership(
  actorId: string,
  roomId: string,
): Promise<{ authorized: true } | { authorized: false; reason: string }> {
  // Canonical group room? Derive admin authority from the ledger.
  const groupRoom = await db.query.groupMatrixRooms.findFirst({
    where: eq(groupMatrixRooms.matrixRoomId, roomId),
    columns: { groupAgentId: true },
  });
  if (groupRoom) {
    const isAdmin = await isGroupRoomAdmin(actorId, groupRoom.groupAgentId);
    return isAdmin
      ? { authorized: true }
      : { authorized: false, reason: "Group admin access required to join users into this room." };
  }

  // Otherwise treat as a direct room and authorize against canonical Synapse
  // membership — the caller must already be a member of the room they are
  // force-joining someone else into.
  const actor = await db.query.agents.findFirst({
    where: eq(agents.id, actorId),
    columns: { matrixUserId: true },
  });
  const actorMatrixUserId = actor?.matrixUserId;
  if (typeof actorMatrixUserId !== "string" || actorMatrixUserId.length === 0) {
    return { authorized: false, reason: "Your account has no Matrix identity yet." };
  }

  let members: string[];
  try {
    members = await getRoomMembers(roomId);
  } catch (err) {
    console.error(
      `[matrix] canActorMutateRoomMembership: getRoomMembers failed for ${roomId}:`,
      err,
    );
    return { authorized: false, reason: "Could not verify room membership." };
  }

  return members.includes(actorMatrixUserId)
    ? { authorized: true }
    : { authorized: false, reason: "Only existing room participants can join users into this room." };
}

/**
 * Force-joins the target user into a DM/group room so they see it immediately
 * without needing to manually accept an invite.
 *
 * This is a client-reachable server action that drives the privileged Synapse
 * admin "force-join" endpoint, so it is authorized with the verified-principal
 * model (EVT-SEC-001): the caller (derived from `auth()`, never the client
 * payload) must be entitled to mutate the room's membership — i.e. be a
 * canonical Synapse member of a direct room, or a ledger-derived admin of the
 * room's owning group. An unauthorized caller is a silent no-op; we never let
 * an arbitrary client force any user into any room.
 *
 * @param targetMatrixUserId - Full Matrix user ID to join
 * @param roomId - The Matrix room ID to join them into
 */
export async function ensureUserJoinedRoom(
  targetMatrixUserId: string,
  roomId: string
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  // Validate Matrix identifier formats to prevent injection of arbitrary strings into admin API calls.
  if (!targetMatrixUserId.startsWith("@")) {
    console.error("[matrix] ensureUserJoinedRoom: invalid targetMatrixUserId, must start with @");
    return;
  }
  if (!roomId.startsWith("!")) {
    console.error("[matrix] ensureUserJoinedRoom: invalid roomId, must start with !");
    return;
  }

  // Authorize the CALLER against canonical room authority before driving the
  // admin force-join. Without this, any authenticated client could force any
  // user into any room.
  const authorization = await canActorMutateRoomMembership(session.user.id, roomId);
  if (!authorization.authorized) {
    console.error(
      "[matrix] ensureUserJoinedRoom: caller not authorized to join users into this room:",
      authorization.reason,
    );
    return;
  }

  try {
    await adminJoinRoom({ userId: targetMatrixUserId, roomId });
  } catch (err) {
    console.error("[matrix] adminJoinRoom failed:", err);
  }
}

/**
 * Resolves a marketplace listing to its owner's Matrix user ID.
 *
 * @param listingId - Resource id for the marketplace listing.
 * @returns The seller's Matrix user ID, or null if the listing/seller cannot be resolved.
 */
export async function getDmRoomForListing(listingId: string): Promise<{
  targetMatrixUserId: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const listing = await db.query.resources.findFirst({
    where: eq(resources.id, listingId),
    columns: {
      ownerId: true,
    },
  });

  if (!listing?.ownerId) return null;

  const matrixUserId = await ensureAgentMatrixIdentity(listing.ownerId);
  if (!matrixUserId) return null;

  return {
    targetMatrixUserId: matrixUserId,
  };
}

/**
 * Fetches all group rooms the current user is a member of.
 *
 * Queries the ledger for active "join" memberships, then resolves
 * each group's Matrix room via the group_matrix_rooms table. Also
 * fetches sub-groups (children agents) for each group.
 *
 * @returns Array of group room metadata, or null if not authenticated.
 */
export async function getUserGroupRooms(): Promise<
  {
    groupId: string;
    groupName: string;
    groupImage: string | null;
    matrixRoomId: string;
    chatMode: string;
    subgroups: { id: string; name: string; matrixRoomId: string | null }[];
  }[]
| null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  // 1. Find all groups the user is an active member of. Match ALL canonical
  //    membership verbs (own/join/belong), not just "join" — a group's OWNER
  //    holds an `own`/`belong` edge and would otherwise be locked out of their
  //    own group chat ("not available on this account") despite being
  //    server-side joined to the room.
  const memberships = await db
    .select({
      objectId: ledger.objectId,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, session.user.id),
        inArray(ledger.verb, ["own", "join", "belong"]),
        eq(ledger.isActive, true)
      )
    );

  const groupIds = memberships
    .map((m) => m.objectId)
    .filter((id): id is string => id !== null);

  if (groupIds.length === 0) return [];

  // 2. Fetch the group agents
  const groupAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      image: agents.image,
    })
    .from(agents)
    .where(inArray(agents.id, groupIds));

  // 3. Fetch Matrix room mappings for these groups
  const matrixRooms = await db
    .select({
      groupAgentId: groupMatrixRooms.groupAgentId,
      matrixRoomId: groupMatrixRooms.matrixRoomId,
      chatMode: groupMatrixRooms.chatMode,
    })
    .from(groupMatrixRooms)
    .where(inArray(groupMatrixRooms.groupAgentId, groupIds));

  const roomsByGroupId = new Map(
    matrixRooms.map((r) => [r.groupAgentId, r])
  );

  // 4. Fetch sub-groups (children) for each group
  const subgroupAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      parentId: agents.parentId,
    })
    .from(agents)
    .where(inArray(agents.parentId, groupIds));

  // Fetch Matrix rooms for sub-groups that have them
  const subgroupIds = subgroupAgents.map((s) => s.id);
  const subgroupMatrixRooms =
    subgroupIds.length > 0
      ? await db
          .select({
            groupAgentId: groupMatrixRooms.groupAgentId,
            matrixRoomId: groupMatrixRooms.matrixRoomId,
          })
          .from(groupMatrixRooms)
          .where(inArray(groupMatrixRooms.groupAgentId, subgroupIds))
      : [];

  const subgroupRoomMap = new Map(
    subgroupMatrixRooms.map((r) => [r.groupAgentId, r.matrixRoomId])
  );

  const subgroupsByParent = new Map<
    string,
    { id: string; name: string; matrixRoomId: string | null }[]
  >();
  for (const sub of subgroupAgents) {
    if (!sub.parentId) continue;
    const list = subgroupsByParent.get(sub.parentId) ?? [];
    list.push({
      id: sub.id,
      name: sub.name,
      matrixRoomId: subgroupRoomMap.get(sub.id) ?? null,
    });
    subgroupsByParent.set(sub.parentId, list);
  }

  // 5. Assemble results — only include groups that have a Matrix room
  const results: {
    groupId: string;
    groupName: string;
    groupImage: string | null;
    matrixRoomId: string;
    chatMode: string;
    subgroups: { id: string; name: string; matrixRoomId: string | null }[];
  }[] = [];

  for (const group of groupAgents) {
    const room = roomsByGroupId.get(group.id);
    if (!room) continue;

    results.push({
      groupId: group.id,
      groupName: group.name,
      groupImage: group.image,
      matrixRoomId: room.matrixRoomId,
      chatMode: room.chatMode,
      subgroups: subgroupsByParent.get(group.id) ?? [],
    });
  }

  return results;
}
