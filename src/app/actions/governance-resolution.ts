"use server";

/**
 * Governance P4 actions — board roles + RECORD-ONLY finalization (locked
 * decisions #4/#6). A board role is held on the member's ACTIVE membership
 * edge (`metadata.boardRole`, scope §9), authored by admins with the same
 * authority as badge/share-class authoring. A closed Decision's outcome is
 * finalized when 2/3 of board-role holders approve; finalization RECORDS the
 * outcome (passed/failed or winner) — no money moves, no capability flips.
 */

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { agents, ledger, type NewLedgerEntry } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { updateFacade } from "@/lib/federation";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
} from "@/app/actions/resource-creation/helpers";
import {
  deriveProposalOutcome,
  derivePollOutcome,
  decisionPhase,
  isBoardRole,
  requiredFinalizeApprovals,
} from "@/lib/governance-resolution";
import { FINALIZE_INTERACTION, boardRoleHolders } from "@/lib/governance-resolution.server";
import type { ActionResult } from "@/app/actions/resource-creation/types";


/** The group's board (role holders with names) — member-visible read. */
export async function listBoardMembersAction(groupId: string): Promise<
  ActionResult & { board?: Array<{ memberId: string; name: string; role: string }> }
> {
  if (!groupId?.trim()) {
    return { success: false, message: "groupId is required", error: { code: "INVALID_INPUT" } };
  }
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }
  try {
    const holders = await boardRoleHolders(groupId);
    if (holders.size === 0) return { success: true, message: "No board roles assigned", board: [] };
    const rows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, [...holders.keys()]));
    const nameById = new Map(rows.map((r) => [r.id, r.name ?? "Member"]));
    return {
      success: true,
      message: "Board fetched",
      board: [...holders.entries()].map(([memberId, role]) => ({
        memberId,
        name: nameById.get(memberId) ?? "Member",
        role,
      })),
    };
  } catch (error) {
    console.error("[listBoardMembersAction] failed:", error);
    return { success: false, message: "Failed to fetch board", error: { code: "SERVER_ERROR" } };
  }
}

/**
 * Assigns (or clears, with `role: null`) a member's board role on their ACTIVE
 * membership edge. Admin-authored (scope §9); board membership is decision
 * authority, orthogonal to economic share-class tiers.
 */
export async function setBoardRoleAction(input: {
  groupId: string;
  memberId: string;
  role: string | null;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.memberId?.trim()) {
    return { success: false, message: "groupId and memberId are required", error: { code: "INVALID_INPUT" } };
  }
  if (input.role !== null && !isBoardRole(input.role)) {
    return { success: false, message: "Unknown board role", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "setBoardRole",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
      const canWrite = await hasGroupWriteAccess(userId, input.groupId);
      if (!canWrite) {
        return {
          success: false,
          message: "Admin access required to assign board roles",
          error: { code: "FORBIDDEN" },
        };
      }

      const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
      if (!check.success) {
        return { success: false, message: "Rate limit exceeded. Please try again later.", error: { code: "RATE_LIMITED" } };
      }

      try {
        // The role lives on the ACTIVE membership edge(s) — no edge, no board seat.
        const updated = input.role === null
          ? await db.execute(sql`
              UPDATE ledger
              SET metadata = metadata - 'boardRole'
              WHERE subject_id = ${input.memberId}::uuid
                AND object_id = ${input.groupId}::uuid
                AND verb IN ('join', 'belong')
                AND is_active = true
              RETURNING id
            `)
          : await db.execute(sql`
              UPDATE ledger
              SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{boardRole}', to_jsonb(${input.role}::text))
              WHERE subject_id = ${input.memberId}::uuid
                AND object_id = ${input.groupId}::uuid
                AND verb IN ('join', 'belong')
                AND is_active = true
              RETURNING id
            `);
        if ((updated as unknown[]).length === 0) {
          return {
            success: false,
            message: "Member has no active membership in this group.",
            error: { code: "NOT_FOUND" },
          };
        }

        revalidatePath(`/groups/${input.groupId}`);
        return {
          success: true,
          message: input.role === null ? "Board role cleared" : "Board role assigned",
        } as ActionResult;
      } catch (error) {
        console.error("[setBoardRoleAction] failed:", error);
        return { success: false, message: "Failed to set board role", error: { code: "SERVER_ERROR" } } as ActionResult;
      }
    }
  );

  if (facadeResult.success && facadeResult.data) return facadeResult.data as ActionResult;
  return {
    success: false,
    message: facadeResult.error ?? "Failed to set board role",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

/**
 * A board-role holder's approval to finalize a CLOSED Decision. When distinct
 * board approvals reach ceil(2/3 × board holders), the item's outcome is
 * derived and RECORDED (`status: "finalized"`, `outcome`, `finalizers`) — and
 * nothing executes (decision #6): users enact the result by hand.
 */
export async function approveDecisionFinalizationAction(input: {
  groupId: string;
  targetId: string;
  targetType: "poll" | "proposal";
}): Promise<ActionResult & { approvals?: number; required?: number; finalized?: boolean }> {
  if (!input.groupId?.trim() || !input.targetId?.trim()) {
    return { success: false, message: "groupId and targetId are required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "approveDecisionFinalization",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
      const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
      if (!check.success) {
        return { success: false, message: "Rate limit exceeded. Please try again later.", error: { code: "RATE_LIMITED" } };
      }

      try {
        const holders = await boardRoleHolders(input.groupId);
        if (!holders.has(userId)) {
          return {
            success: false,
            message: "Only board-role holders can approve finalization.",
            error: { code: "FORBIDDEN" },
          };
        }

        const [groupRow] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
          .limit(1);
        if (!groupRow) {
          return { success: false, message: "Group not found", error: { code: "NOT_FOUND" } };
        }

        const groupMeta = groupRow.metadata && typeof groupRow.metadata === "object"
          ? (groupRow.metadata as Record<string, unknown>)
          : {};
        const metaKey = input.targetType === "poll" ? "polls" : "proposals";
        const items = Array.isArray(groupMeta[metaKey]) ? [...(groupMeta[metaKey] as Record<string, unknown>[])] : [];
        const idx = items.findIndex((item) => String(item.id) === input.targetId);
        if (idx < 0) {
          return { success: false, message: "Governance item does not belong to this group.", error: { code: "FORBIDDEN" } };
        }

        const phase = decisionPhase(items[idx]);
        if (phase === "finalized") {
          return { success: false, message: "This decision is already finalized.", error: { code: "INVALID_INPUT" } };
        }
        if (phase === "active") {
          return {
            success: false,
            message: "Voting is still open — finalization starts when the window closes.",
            error: { code: "INVALID_INPUT" },
          };
        }

        // Idempotent per approver: one ACTIVE finalize-approval edge.
        const existing = (await db.execute(sql`
          SELECT id FROM ledger
          WHERE subject_id = ${userId}::uuid
            AND object_id = ${input.groupId}::uuid
            AND verb = 'approve'
            AND is_active = true
            AND metadata->>'targetId' = ${input.targetId}
            AND metadata->>'interactionType' = ${FINALIZE_INTERACTION}
          LIMIT 1
        `)) as unknown[];
        if (existing.length === 0) {
          await db.insert(ledger).values({
            verb: "approve",
            subjectId: userId,
            objectId: input.groupId,
            objectType: "agent",
            isActive: true,
            metadata: {
              groupId: input.groupId,
              targetId: input.targetId,
              targetType: input.targetType,
              interactionType: FINALIZE_INTERACTION,
              boardRole: holders.get(userId),
              approvedAt: new Date().toISOString(),
            },
          } as NewLedgerEntry);
        }

        // Distinct CURRENT board holders with an active approval.
        const approvalRows = (await db.execute(sql`
          SELECT DISTINCT subject_id FROM ledger
          WHERE object_id = ${input.groupId}::uuid
            AND verb = 'approve'
            AND is_active = true
            AND metadata->>'targetId' = ${input.targetId}
            AND metadata->>'interactionType' = ${FINALIZE_INTERACTION}
        `)) as Array<Record<string, unknown>>;
        const approvers = approvalRows
          .map((r) => String(r.subject_id ?? ""))
          .filter((id) => holders.has(id));
        const required = requiredFinalizeApprovals(holders.size);
        const finalized = approvers.length >= required;

        if (finalized) {
          const item = { ...items[idx] };
          const outcome =
            input.targetType === "proposal"
              ? deriveProposalOutcome({
                  votes: (item.votes ?? { yes: 0, no: 0, abstain: 0 }) as { yes: number; no: number; abstain: number },
                  totalVoters: Number(item.totalVoters ?? 0),
                  quorum: Number(item.quorum ?? 0),
                  threshold: Number(item.threshold ?? 50),
                })
              : derivePollOutcome(item as Parameters<typeof derivePollOutcome>[0]);
          item.status = "finalized";
          item.outcome = outcome;
          item.finalizedAt = new Date().toISOString();
          item.finalizers = approvers;
          items[idx] = item;
          await db
            .update(agents)
            .set({ metadata: { ...groupMeta, [metaKey]: items }, updatedAt: new Date() })
            .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));
        }

        revalidatePath(`/groups/${input.groupId}`);
        return {
          success: true,
          message: finalized
            ? "Decision finalized — outcome recorded. Enact the result manually."
            : `Finalization approval recorded (${approvers.length}/${required}).`,
          approvals: approvers.length,
          required,
          finalized,
        } as ActionResult & { approvals: number; required: number; finalized: boolean };
      } catch (error) {
        console.error("[approveDecisionFinalizationAction] failed:", error);
        return { success: false, message: "Failed to record finalization approval", error: { code: "SERVER_ERROR" } } as ActionResult;
      }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult & { approvals?: number; required?: number; finalized?: boolean };
  }
  return {
    success: false,
    message: facadeResult.error ?? "Failed to record finalization approval",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}
