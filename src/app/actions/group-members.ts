"use server";

/**
 * Admin member management (2026-07-10).
 *
 * Until now membership ONLY came from self-join or request→approve — there
 * was no way for an admin to add someone, which is how Jordan Siegel ended
 * up invisible on Spirit (signed up, never joined, nobody could add her).
 *
 * `addGroupMemberAction` writes the standard membership edge (verb `belong`,
 * `metadata.interactionType: 'membership'`) exactly like the approve flow,
 * idempotently: an existing active membership is role-updated in place, never
 * duplicated. Adding as admin also maintains the group's `metadata.adminIds`
 * so BOTH authority representations (`isDirectGroupAdmin` reads either) agree.
 *
 * Remote-homed people qualify — their projected local agent row (the
 * federation identity-normalization pattern) is what the edge binds to, same
 * as every other interaction on a sovereign instance.
 */

import { revalidatePath } from "next/cache";
import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";

/** Roles an admin may assign when adding a member. */
export type AddableMemberRole = "member" | "admin";

export interface AddableAgent {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
}

/** Max results returned by the picker search. */
const SEARCH_LIMIT = 10;

/** Whether the caller holds admin authority over the group. */
async function callerIsGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const { isGroupAdmin } = await import("@/app/actions/group-admin");
  return isGroupAdmin(userId, groupId);
}

/**
 * Searches person agents an admin could add to the group: local AND projected
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

  // Drop existing active members so the picker only offers real additions.
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
 * Adds (or promotes) a member to the group. Admin-gated; idempotent per
 * agent+group — an existing active edge gets its role updated in place.
 * Admin role additionally maintains `metadata.adminIds` on the group agent.
 */
export async function addGroupMemberAction(
  groupId: string,
  agentId: string,
  role: AddableMemberRole = "member",
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to add members." };
  if (!isUuid(groupId) || !isUuid(agentId)) return { success: false, message: "Invalid group or agent id." };
  if (role !== "member" && role !== "admin") return { success: false, message: "Invalid role." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  if (!(await callerIsGroupAdmin(userId, groupId))) {
    return { success: false, message: "Only a group admin can add members." };
  }

  const [target] = await db
    .select({ id: agents.id, name: agents.name, type: agents.type })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!target) return { success: false, message: "Agent not found." };
  if (target.type !== "person") {
    return { success: false, message: "Only person agents can be added as members." };
  }

  const facadeResult = await federatedWrite(
    {
      type: "addGroupMemberAction",
      actorId: userId,
      targetAgentId: groupId,
      payload: { groupId, agentId, role },
    },
    async () => {
      // Idempotent: role-update an existing active edge instead of duplicating.
      const [existing] = await db
        .select({ id: ledger.id, role: ledger.role })
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

      let message: string;
      if (existing) {
        if (existing.role === role) {
          message = `${target.name} is already a ${role} of this group.`;
        } else {
          await db.update(ledger).set({ role }).where(eq(ledger.id, existing.id));
          message = `${target.name} is now a ${role}.`;
        }
      } else {
        await db.insert(ledger).values({
          verb: "belong",
          subjectId: agentId,
          objectId: groupId,
          objectType: "agent",
          isActive: true,
          role,
          visibility: "public",
          metadata: {
            interactionType: "membership",
            addedBy: userId,
            source: "admin-add-member",
          },
        } as NewLedgerEntry);
        message = `${target.name} added as ${role}.`;
      }

      // Keep the metadata authority representation in agreement for admins.
      if (role === "admin") {
        await db.execute(sql`
          UPDATE agents
          SET metadata = jsonb_set(
                metadata,
                '{adminIds}',
                COALESCE(metadata->'adminIds','[]'::jsonb) || to_jsonb(${agentId}::text)
              ),
              updated_at = now()
          WHERE id = ${groupId}::uuid
            AND NOT (COALESCE(metadata->'adminIds','[]'::jsonb) ? ${agentId})
        `);
      }

      revalidatePath(`/groups/${groupId}`);
      revalidatePath("/");
      return { success: true, message } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to add the member." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "agent",
    entityId: groupId,
    actorId: userId,
    payload: { action: "member_added", groupId, agentId, role },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Member added." };
}
