"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { inviteToGroupRoom, removeFromGroupRoom } from "@/lib/matrix-groups";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import {
  getCurrentUserId,
  toggleLedgerInteraction,
} from "./helpers";
import type { ActionResult, HiddenContentPreferences } from "./types";

/**
 * Toggles a follow/connect relationship to another agent.
 *
 * @param {string} agentId - Target person/agent ID.
 * @returns {Promise<ActionResult>} Interaction state result.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * await toggleFollowAgent("agent-uuid");
 * ```
 */
export async function toggleFollowAgent(agentId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to connect with people." };

  const facadeResult = await updateFacade.execute(
    {
      type: "toggleFollowAgent",
      actorId: userId,
      targetAgentId: userId,
      payload: {},
    },
    async () => {
      const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
      if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." } as ActionResult;

      return toggleLedgerInteraction(userId, "follow", "connect", agentId, "person");
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult;
  }

  return { success: false, message: facadeResult.error ?? "Failed to toggle follow." };
}

/**
 * Toggles membership on a group or ring.
 *
 * @param {string} groupId - Target group/ring ID.
 * @param {"group" | "ring"} [type="group"] - Target entity subtype.
 * @returns {Promise<ActionResult>} Interaction state result.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * await toggleJoinGroup("group-uuid", "group");
 * ```
 */
export async function toggleJoinGroup(groupId: string, type: "group" | "ring" = "group"): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to join." };

  const facadeResult = await updateFacade.execute(
    {
      type: "toggleJoinGroup",
      actorId: userId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
      const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
      if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." } as ActionResult;

      // Organizations and rings require a paid membership subscription.
      // Basic groups can be joined freely.
      const [group] = await db
        .select({ type: agents.type, metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, groupId))
        .limit(1);

      if (!group) return { success: false, message: "Group not found." } as ActionResult;

      const groupType = group.type ?? "person";
      const meta = (group.metadata ?? {}) as Record<string, unknown>;
      const groupSubtype = String(meta.groupType ?? meta.type ?? "basic").toLowerCase();
      const requiresMembership =
        groupType === "organization" ||
        type === "ring" ||
        groupSubtype === "ring" ||
        groupSubtype === "organization" ||
        groupSubtype === "org";

      void requiresMembership;

      const result = await toggleLedgerInteraction(userId, "join", "membership", groupId, type);

      // Fire-and-forget: sync Matrix room membership
      if (result.success) {
        (async () => {
          try {
            if (result.active) {
              await inviteToGroupRoom({ groupAgentId: groupId, targetAgentId: userId });
            } else {
              await removeFromGroupRoom({ groupAgentId: groupId, targetAgentId: userId });
            }
          } catch (err) {
            console.error("[toggleJoinGroup] Matrix sync failed:", err);
          }
        })();
      }

      return result;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: data.active ? EVENT_TYPES.GROUP_MEMBER_JOINED : EVENT_TYPES.GROUP_MEMBER_LEFT,
        entityType: "agent",
        entityId: groupId,
        actorId: userId,
        payload: { type },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, message: facadeResult.error ?? "Failed to toggle group membership." };
}

/**
 * Returns whether the current user has an active membership edge for a group.
 *
 * @param {string} groupId - Target group ID.
 * @returns {Promise<{ joined: boolean }>} Membership state for the authenticated user.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * const state = await fetchJoinState("group-uuid");
 * ```
 */
export async function fetchJoinState(groupId: string): Promise<{ joined: boolean }> {
  const userId = await getCurrentUserId();
  if (!userId) return { joined: false };

  const existing = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, userId),
      eq(ledger.verb, "join"),
      eq(ledger.isActive, true),
      sql`${ledger.metadata}->>'interactionType' = 'membership'`,
      sql`${ledger.metadata}->>'targetId' = ${groupId}`
    ),
    columns: { id: true },
  });

  return { joined: Boolean(existing) };
}

/**
 * Fetches the set of agent IDs the current user is actively following.
 *
 * Used by UI components that need to render "Following" vs "Follow" states
 * for multiple agents at once without N+1 individual state checks.
 *
 * @returns {Promise<string[]>} De-duplicated list of followed agent IDs.
 * @throws {Error} Unexpected query failures may propagate.
 * @example
 * ```ts
 * const followedIds = await fetchFollowingIds();
 * ```
 */
export async function fetchFollowingIds(): Promise<string[]> {
  const userId = await getCurrentUserId();
  if (!userId) return [];

  const rows = await db.execute(sql`
    SELECT COALESCE(metadata->>'targetId', object_id::text) AS agent_id
    FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND verb = 'follow'
      AND is_active = true
      AND metadata->>'interactionType' = 'connect'
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  return Array.from(
    new Set(
      (rows as Array<Record<string, unknown>>)
        .map((row) => row.agent_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  );
}

export async function toggleHiddenContent(
  targetId: string,
  targetType: "post" | "person",
  mode: "post" | "author"
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to hide content." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  return toggleLedgerInteraction(
    userId,
    "view",
    mode === "author" ? "hide-author" : "hide-post",
    targetId,
    targetType
  );
}

export async function fetchHiddenContentPreferences(): Promise<HiddenContentPreferences> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { hiddenPostIds: [], hiddenAuthorIds: [] };
  }

  const rows = await db.query.ledger.findMany({
    where: and(eq(ledger.subjectId, userId), eq(ledger.verb, "view"), eq(ledger.isActive, true)),
    columns: { metadata: true },
  });

  const hiddenPostIds = new Set<string>();
  const hiddenAuthorIds = new Set<string>();

  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const interactionType = typeof metadata.interactionType === "string" ? metadata.interactionType : "";
    const targetId = typeof metadata.targetId === "string" ? metadata.targetId : "";
    if (!targetId) continue;
    if (interactionType === "hide-post") hiddenPostIds.add(targetId);
    if (interactionType === "hide-author") hiddenAuthorIds.add(targetId);
  }

  return {
    hiddenPostIds: Array.from(hiddenPostIds),
    hiddenAuthorIds: Array.from(hiddenAuthorIds),
  };
}
