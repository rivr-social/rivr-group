"use server";

/**
 * Project completion settlement + subgroup treasury guarantees (2026-07-10).
 *
 * Cameron's flow: every subgroup has a TREASURY, and when a project
 * completes its funds flow through EXPENSES and the remainder lands IN the
 * owning (sub)group's treasury.
 *
 * - Expenses are already first-class debits (`recordProjectExpense` moves
 *   money out of the project wallet when recorded), so at completion the
 *   project wallet balance IS the net-after-expenses.
 * - `completeProjectAction` marks the project completed and SWEEPS that net
 *   into the owning group's settlement wallet (its treasury) over the
 *   standard `transferP2P` rail, chunked at MAX_TRANSFER_CENTS, idempotent
 *   via `metadata.completionSettlement` — re-running never double-sweeps.
 * - Explicit J7 net-distribution (stake/lineage splits) remains a separate,
 *   deliberately manual action; run it BEFORE completing when a project's
 *   net should split beyond its own group — completion sweeps whatever
 *   remains.
 * - `ensureSubgroupTreasuriesAction` walks the group subtree and creates any
 *   missing settlement wallets so every subgroup has a treasury up front
 *   (wallets were previously created lazily on first use).
 */

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";
import {
  getProjectWalletForResource,
  getSettlementWalletForAgent,
  getWalletBalance,
  transferP2P,
} from "@/lib/wallet";
import { MAX_TRANSFER_CENTS } from "@/lib/wallet-constants";

/** Metadata key recording the one-time completion sweep (idempotency anchor). */
const SETTLEMENT_KEY = "completionSettlement";

export interface CompleteProjectResult extends ActionResult {
  /** Net cents swept into the owning group's treasury (0 = nothing to move). */
  sweptCents?: number;
  /** Total expense debits recorded against the project wallet, for the books. */
  expenseCents?: number;
}

/** Sum of `project_expense` debits recorded against a wallet. */
async function getExpenseTotalCents(walletId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM wallet_transactions
    WHERE from_wallet_id = ${walletId}::uuid AND type = 'project_expense'
  `)) as Array<{ total: string | number }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Marks a project COMPLETED and settles its treasury: expenses are already
 * debited, so the remaining project-wallet balance sweeps into the owning
 * group's settlement wallet. Owner/group-admin or project-lead gated.
 * Idempotent — a completed project with a recorded settlement never moves
 * money again (re-running retries ONLY a previously-empty sweep).
 */
export async function completeProjectAction(projectId: string): Promise<CompleteProjectResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to complete a project." };
  if (!isUuid(projectId)) return { success: false, message: "Invalid project id." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [project] = await db
    .select({ id: resources.id, name: resources.name, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, projectId), eq(resources.type, "project"), isNull(resources.deletedAt)))
    .limit(1);
  if (!project) return { success: false, message: "Project not found." };

  const meta = (project.metadata ?? {}) as Record<string, unknown>;

  // Authorization: group authority or the project lead.
  const { hasGroupWriteAccess } = await import("@/app/actions/resource-creation/helpers");
  const isLead = typeof meta.leadId === "string" && meta.leadId === userId;
  const canComplete = isLead || project.ownerId === userId || (await hasGroupWriteAccess(userId, project.ownerId));
  if (!canComplete) {
    return { success: false, message: "Only a group admin or the project lead can complete a project." };
  }

  const priorSettlement = (meta[SETTLEMENT_KEY] ?? null) as Record<string, unknown> | null;
  if (priorSettlement && Number(priorSettlement.sweptCents ?? 0) > 0) {
    return {
      success: true,
      message: "Project is already completed and its treasury was settled.",
      sweptCents: 0,
    };
  }

  const facadeResult = await federatedWrite(
    {
      type: "completeProjectAction",
      actorId: userId,
      targetAgentId: project.ownerId,
      payload: { projectId },
    },
    async () => {
      const now = new Date().toISOString();

      // Settle the treasury FIRST so a sweep failure never strands a project
      // marked completed with money still in its wallet.
      let sweptCents = 0;
      let expenseCents = 0;
      const txIds: string[] = [];
      const projectWallet = await getProjectWalletForResource(projectId);
      if (projectWallet) {
        expenseCents = await getExpenseTotalCents(projectWallet.id);
        const balance = await getWalletBalance(projectWallet.id);
        let remaining = balance.balanceCents;
        if (remaining > 0) {
          const treasury = await getSettlementWalletForAgent(project.ownerId);
          while (remaining > 0) {
            const chunk = Math.min(remaining, MAX_TRANSFER_CENTS);
            const tx = await transferP2P(
              projectWallet.id,
              treasury.id,
              chunk,
              `Project completion: ${project.name} — net to treasury`,
            );
            txIds.push(tx.id);
            remaining -= chunk;
            sweptCents += chunk;
          }
        }
      }

      await db
        .update(resources)
        .set({
          metadata: {
            ...meta,
            status: "completed",
            completedAt: now,
            completedBy: userId,
            [SETTLEMENT_KEY]: {
              sweptCents,
              expenseCents,
              treasuryOwnerId: project.ownerId,
              transactionIds: txIds,
              settledAt: now,
              settledBy: userId,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(resources.id, projectId));

      // Provenance edge for the activity feed / REA record.
      await db.insert(ledger).values({
        verb: "complete",
        subjectId: userId,
        objectId: projectId,
        objectType: "resource",
        resourceId: projectId,
        isActive: true,
        metadata: {
          interactionType: "project-completion",
          sweptCents,
          expenseCents,
          treasuryOwnerId: project.ownerId,
        },
      } as NewLedgerEntry);

      revalidatePath(`/projects/${projectId}`);
      revalidatePath(`/groups/${project.ownerId}`);

      const money =
        sweptCents > 0
          ? ` $${(expenseCents / 100).toFixed(2)} in expenses were already settled; $${(sweptCents / 100).toFixed(2)} net swept to the group treasury.`
          : expenseCents > 0
            ? ` $${(expenseCents / 100).toFixed(2)} in expenses were already settled; no remaining funds to sweep.`
            : "";
      return {
        success: true,
        message: `Project completed.${money}`,
        sweptCents,
        expenseCents,
      } as CompleteProjectResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to complete the project." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: projectId,
    actorId: userId,
    payload: { action: "project_completed", projectId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Project completed." };
}

export interface EnsureTreasuriesResult extends ActionResult {
  /** Subgroups that received a NEW treasury wallet. */
  created?: string[];
  /** Subgroups whose treasury already existed. */
  existing?: number;
}

/**
 * Guarantees a treasury (settlement wallet) for the group AND every
 * descendant subgroup. Wallets were created lazily on first money movement;
 * this makes them first-class up front so every subgroup's Treasury tab is
 * live. Admin-gated; idempotent (getOrCreateWallet races safely).
 */
export async function ensureSubgroupTreasuriesAction(groupId: string): Promise<EnsureTreasuriesResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in." };
  if (!isUuid(groupId)) return { success: false, message: "Invalid group id." };

  const { isGroupAdmin } = await import("@/app/actions/group-admin");
  if (!(await isGroupAdmin(userId, groupId))) {
    return { success: false, message: "Only a group admin can provision subgroup treasuries." };
  }

  const rows = (await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id, name FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id, a.name FROM agents a JOIN grp_tree t ON a.parent_id = t.id
      WHERE a.deleted_at IS NULL AND a.type <> 'person'
    )
    SELECT g.id, g.name, w.id IS NOT NULL AS has_wallet
    FROM grp_tree g
    LEFT JOIN wallets w ON w.owner_id = g.id AND w.type = 'group' AND w.resource_id IS NULL
  `)) as Array<{ id: string; name: string; has_wallet: boolean }>;

  const created: string[] = [];
  let existing = 0;
  for (const row of rows) {
    if (row.has_wallet) {
      existing += 1;
      continue;
    }
    await getSettlementWalletForAgent(row.id);
    created.push(row.name);
  }

  revalidatePath(`/groups/${groupId}`);
  return {
    success: true,
    message:
      created.length > 0
        ? `Created ${created.length} treasur${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}. ${existing} already existed.`
        : `All ${existing} treasuries already exist.`,
    created,
    existing,
  };
}
