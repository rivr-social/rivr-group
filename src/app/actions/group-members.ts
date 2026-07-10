"use server";

/**
 * Group membership INVITATIONS (2026-07-10).
 *
 * Membership requires CONSENT on both sides: admins never add anyone
 * directly — they extend an invitation the person accepts or declines
 * (mirroring the request→approve flow in the opposite direction). This fills
 * the gap that left signed-up-but-never-joined people invisible (the Jordan
 * case) without letting groups conscript users.
 *
 * Ledger shape — verb `invite`, subject = INVITER, object = INVITEE (agent):
 * pointing the row at the invitee makes it surface in their notifications
 * feed automatically (fetchNotifications lists rows targeting the viewer).
 * `metadata.reviewStatus` drives the lifecycle: 'pending' → 'accepted' |
 * 'declined' | 'cancelled'. Accepting writes the STANDARD membership edge
 * (verb `belong`, interactionType 'membership') with the invited role;
 * admin invitations also maintain the group's `metadata.adminIds` so both
 * authority representations (`isDirectGroupAdmin` reads either) agree.
 */

import { revalidatePath } from "next/cache";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";

/** Roles an admin may offer with an invitation. */
export type InvitableMemberRole = "member" | "admin";

/** Ledger interactionType for membership invitations. */
const INVITE_INTERACTION = "group-membership-invite";

export interface AddableAgent {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
}

export interface GroupInvite {
  id: string;
  inviteeId: string;
  inviteeName: string;
  invitedBy: string;
  role: InvitableMemberRole;
  invitedAt: string;
}

export interface MyGroupInvite {
  id: string;
  groupId: string;
  role: InvitableMemberRole;
  inviterName: string;
}

/** Max results returned by the picker search. */
const SEARCH_LIMIT = 10;

/** Whether the caller holds admin authority over the group. */
async function callerIsGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const { isGroupAdmin } = await import("@/app/actions/group-admin");
  return isGroupAdmin(userId, groupId);
}

/** Whether the agent already holds an active membership edge on the group. */
async function hasActiveMembership(agentId: string, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, agentId),
        eq(ledger.objectId, groupId),
        or(eq(ledger.verb, "join"), eq(ledger.verb, "belong")),
        eq(ledger.isActive, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The invitee's PENDING invite row for a group, if any. */
async function findPendingInvite(inviteeId: string, groupId: string) {
  const rows = (await db.execute(sql`
    SELECT id, metadata FROM ledger
    WHERE verb = 'invite'
      AND object_id = ${inviteeId}::uuid
      AND metadata->>'interactionType' = ${INVITE_INTERACTION}
      AND metadata->>'groupId' = ${groupId}
      AND COALESCE(metadata->>'reviewStatus','pending') = 'pending'
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<{ id: string; metadata: Record<string, unknown> }>;
  return rows[0] ?? null;
}

/**
 * Searches person agents an admin could invite: local AND projected
 * (federated) people, excluding current active members. Admin-gated — the
 * picker is a membership-management surface, not a public directory.
 */
export async function searchAddableAgents(
  groupId: string,
  query: string,
): Promise<AddableAgent[]> {
  const userId = await getCurrentUserId();
  if (!userId || !isUuid(groupId)) return [];
  if (!(await callerIsGroupAdmin(userId, groupId))) return [];

  const needle = `%${query.trim()}%`;
  if (query.trim().length < 2) return [];

  const rows = await db
    .select({ id: agents.id, name: agents.name, image: agents.image, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.type, "person"),
        isNull(agents.deletedAt),
        or(ilike(agents.name, needle), sql`${agents.metadata}->>'username' ILIKE ${needle}`),
      ),
    )
    .limit(SEARCH_LIMIT * 3);

  if (rows.length === 0) return [];

  // Drop existing active members so the picker only offers real invitations.
  const candidateIds = rows.map((r) => r.id);
  const memberRows = await db
    .select({ subjectId: ledger.subjectId })
    .from(ledger)
    .where(
      and(
        inArray(ledger.subjectId, candidateIds),
        eq(ledger.objectId, groupId),
        or(eq(ledger.verb, "join"), eq(ledger.verb, "belong")),
        eq(ledger.isActive, true),
      ),
    );
  const memberIds = new Set(memberRows.map((r) => r.subjectId));

  return rows
    .filter((r) => !memberIds.has(r.id))
    .slice(0, SEARCH_LIMIT)
    .map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        name: r.name,
        username: typeof meta.username === "string" ? meta.username : null,
        image: r.image ?? null,
      };
    });
}

/**
 * Extends a membership invitation. Admin-gated; idempotent — an existing
 * PENDING invite for the same person is refreshed (role updated) rather than
 * duplicated, and current members are rejected. Membership is created only
 * when the invitee ACCEPTS.
 */
export async function inviteGroupMemberAction(
  groupId: string,
  agentId: string,
  role: InvitableMemberRole = "member",
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to invite members." };
  if (!isUuid(groupId) || !isUuid(agentId)) return { success: false, message: "Invalid group or agent id." };
  if (role !== "member" && role !== "admin") return { success: false, message: "Invalid role." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  if (!(await callerIsGroupAdmin(userId, groupId))) {
    return { success: false, message: "Only a group admin can invite members." };
  }

  const [target] = await db
    .select({ id: agents.id, name: agents.name, type: agents.type })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!target) return { success: false, message: "Agent not found." };
  if (target.type !== "person") {
    return { success: false, message: "Only person agents can be invited." };
  }
  if (await hasActiveMembership(agentId, groupId)) {
    return { success: false, message: `${target.name} is already a member of this group.` };
  }

  const facadeResult = await federatedWrite(
    {
      type: "inviteGroupMemberAction",
      actorId: userId,
      targetAgentId: groupId,
      payload: { groupId, agentId, role },
    },
    async () => {
      const now = new Date().toISOString();
      const existing = await findPendingInvite(agentId, groupId);
      if (existing) {
        await db.execute(sql`
          UPDATE ledger
          SET metadata = metadata || ${JSON.stringify({ role, invitedBy: userId, invitedAt: now })}::jsonb
          WHERE id = ${existing.id}::uuid
        `);
        revalidatePath(`/groups/${groupId}`);
        return {
          success: true,
          message: `Invitation to ${target.name} refreshed (${role}).`,
        } as ActionResult;
      }

      await db.insert(ledger).values({
        verb: "invite",
        subjectId: userId,
        objectId: agentId,
        objectType: "agent",
        isActive: true,
        visibility: "private",
        metadata: {
          interactionType: INVITE_INTERACTION,
          groupId,
          role,
          reviewStatus: "pending",
          invitedBy: userId,
          invitedAt: now,
        },
      } as NewLedgerEntry);

      revalidatePath(`/groups/${groupId}`);
      return {
        success: true,
        message: `${target.name} invited as ${role} — membership starts when they accept.`,
      } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to send the invitation." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "agent",
    entityId: groupId,
    actorId: userId,
    payload: { action: "member_invited", groupId, agentId, role },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Invitation sent." };
}

/**
 * The invitee accepts or declines. INVITEE-gated (the invite must target the
 * caller). Accepting writes the standard membership edge with the invited
 * role and, for admin invitations, maintains the group's adminIds.
 */
export async function respondToGroupInviteAction(
  inviteId: string,
  accept: boolean,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to respond to an invitation." };
  if (!isUuid(inviteId)) return { success: false, message: "Invalid invitation id." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const rows = (await db.execute(sql`
    SELECT id, object_id, metadata FROM ledger
    WHERE id = ${inviteId}::uuid
      AND verb = 'invite'
      AND metadata->>'interactionType' = ${INVITE_INTERACTION}
    LIMIT 1
  `)) as Array<{ id: string; object_id: string; metadata: Record<string, unknown> }>;
  const invite = rows[0];
  if (!invite) return { success: false, message: "Invitation not found." };
  if (invite.object_id !== userId) {
    return { success: false, message: "Only the invited person can respond to this invitation." };
  }
  if (String(invite.metadata.reviewStatus ?? "pending") !== "pending") {
    return { success: false, message: "This invitation has already been resolved." };
  }

  const groupId = String(invite.metadata.groupId ?? "");
  const role: InvitableMemberRole = invite.metadata.role === "admin" ? "admin" : "member";
  if (!isUuid(groupId)) return { success: false, message: "Invitation is malformed (no group)." };

  const facadeResult = await federatedWrite(
    {
      type: "respondToGroupInviteAction",
      actorId: userId,
      targetAgentId: groupId,
      payload: { inviteId, accept },
    },
    async () => {
      const resolvedAt = new Date().toISOString();
      await db.execute(sql`
        UPDATE ledger
        SET is_active = false,
            metadata = metadata || ${JSON.stringify({
              reviewStatus: accept ? "accepted" : "declined",
              resolvedAt,
            })}::jsonb
        WHERE id = ${inviteId}::uuid
      `);

      if (!accept) {
        revalidatePath(`/groups/${groupId}`);
        return { success: true, message: "Invitation declined." } as ActionResult;
      }

      if (!(await hasActiveMembership(userId, groupId))) {
        await db.insert(ledger).values({
          verb: "belong",
          subjectId: userId,
          objectId: groupId,
          objectType: "agent",
          isActive: true,
          role,
          visibility: "public",
          metadata: {
            interactionType: "membership",
            source: "invitation",
            inviteId,
          },
        } as NewLedgerEntry);
      }

      if (role === "admin") {
        await db.execute(sql`
          UPDATE agents
          SET metadata = jsonb_set(
                metadata,
                '{adminIds}',
                COALESCE(metadata->'adminIds','[]'::jsonb) || to_jsonb(${userId}::text)
              ),
              updated_at = now()
          WHERE id = ${groupId}::uuid
            AND NOT (COALESCE(metadata->'adminIds','[]'::jsonb) ? ${userId})
        `);
      }

      revalidatePath(`/groups/${groupId}`);
      revalidatePath("/");
      return { success: true, message: `Welcome — you joined as ${role}.` } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to respond to the invitation." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "agent",
    entityId: groupId,
    actorId: userId,
    payload: { action: accept ? "invite_accepted" : "invite_declined", groupId, inviteId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: accept ? "Invitation accepted." : "Invitation declined." };
}

/** Cancels a PENDING invitation (admin-gated). */
export async function cancelGroupInviteAction(inviteId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in." };
  if (!isUuid(inviteId)) return { success: false, message: "Invalid invitation id." };

  const rows = (await db.execute(sql`
    SELECT id, metadata FROM ledger
    WHERE id = ${inviteId}::uuid AND verb = 'invite'
      AND metadata->>'interactionType' = ${INVITE_INTERACTION}
    LIMIT 1
  `)) as Array<{ id: string; metadata: Record<string, unknown> }>;
  const invite = rows[0];
  if (!invite) return { success: false, message: "Invitation not found." };
  const groupId = String(invite.metadata.groupId ?? "");
  if (!isUuid(groupId) || !(await callerIsGroupAdmin(userId, groupId))) {
    return { success: false, message: "Only a group admin can cancel an invitation." };
  }
  if (String(invite.metadata.reviewStatus ?? "pending") !== "pending") {
    return { success: false, message: "This invitation has already been resolved." };
  }

  await db.execute(sql`
    UPDATE ledger
    SET is_active = false,
        metadata = metadata || ${JSON.stringify({ reviewStatus: "cancelled", resolvedAt: new Date().toISOString(), cancelledBy: userId })}::jsonb
    WHERE id = ${inviteId}::uuid
  `);
  revalidatePath(`/groups/${groupId}`);
  return { success: true, message: "Invitation cancelled." };
}

/** PENDING invitations for a group, with invitee names (admin-gated). */
export async function listGroupInvites(groupId: string): Promise<GroupInvite[]> {
  const userId = await getCurrentUserId();
  if (!userId || !isUuid(groupId)) return [];
  if (!(await callerIsGroupAdmin(userId, groupId))) return [];

  const rows = (await db.execute(sql`
    SELECT l.id, l.object_id, a.name, l.metadata
    FROM ledger l
    JOIN agents a ON a.id = l.object_id AND a.deleted_at IS NULL
    WHERE l.verb = 'invite'
      AND l.metadata->>'interactionType' = ${INVITE_INTERACTION}
      AND l.metadata->>'groupId' = ${groupId}
      AND COALESCE(l.metadata->>'reviewStatus','pending') = 'pending'
    ORDER BY l.timestamp DESC
    LIMIT 50
  `)) as Array<{ id: string; object_id: string; name: string; metadata: Record<string, unknown> }>;

  return rows.map((row) => ({
    id: row.id,
    inviteeId: row.object_id,
    inviteeName: row.name,
    invitedBy: String(row.metadata.invitedBy ?? ""),
    role: row.metadata.role === "admin" ? "admin" : "member",
    invitedAt: String(row.metadata.invitedAt ?? ""),
  }));
}

/** The viewer's own PENDING invitation to a group (feeds the accept banner). */
export async function getMyPendingGroupInvite(groupId: string): Promise<MyGroupInvite | null> {
  const userId = await getCurrentUserId();
  if (!userId || !isUuid(groupId)) return null;

  const invite = await findPendingInvite(userId, groupId);
  if (!invite) return null;

  const inviterId = String(invite.metadata.invitedBy ?? "");
  let inviterName = "A group admin";
  if (isUuid(inviterId)) {
    const [inviter] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, inviterId))
      .limit(1);
    if (inviter) inviterName = inviter.name;
  }

  return {
    id: invite.id,
    groupId,
    role: invite.metadata.role === "admin" ? "admin" : "member",
    inviterName,
  };
}
