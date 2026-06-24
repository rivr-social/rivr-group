'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  wallets,
  walletTransactions,
  ledger,
  resources,
  agents,
} from '@/db/schema';
import type { NewLedgerEntry } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getProjectWalletForResource,
  getSettlementWalletForAgent,
  consumeWalletCapital,
  creditWalletCapital,
} from '@/lib/wallet';
import { hasGroupWriteAccess } from '@/app/actions/resource-creation/helpers';
import { emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import {
  parseNetAllocationTree,
  resolveNetAllocation,
  type NetAllocationTree,
} from '@/lib/net-allocation';
import { getGroupMembersByClass } from './net-allocation';
import {
  planProjectNetDistribution,
  type DistributionRunPlan,
} from '@/lib/net-distribution-run';
import { getCurrentUserId } from './helpers';
import { isUuid } from './types';

const RESOURCE_TYPE_PROJECT = 'project';
/** Wallet-transaction type for a Layer-2 distribution credit (migration 0042). */
const DISTRIBUTION_TX_TYPE = 'project_distribution' as const;

/**
 * MONEY-SAFETY GUARD. The distribution RUN moves real funds out of a project
 * treasury into recipient wallets. It is deliberately NOT wired to any cron or
 * auto-trigger: it only executes when a controller explicitly invokes this
 * action AND passes `confirm: true`. A dry-run (the default) returns the exact
 * plan without touching any balance so the controller can review amounts first.
 */
export interface RunProjectNetDistributionInput {
  /** The `project` resource whose treasury net is distributed. */
  projectId: string;
  /** The owning group/org agent id whose net-allocation tree governs the split. */
  groupId: string;
  /** Net amount (cents) to distribute. Bounded by the project wallet balance. */
  netCents: number;
  /**
   * Explicit execution flag. When omitted/false the action returns the plan
   * WITHOUT moving money (dry run). Only `true` performs the credit/debit.
   */
  confirm?: boolean;
}

export interface RunProjectNetDistributionResult {
  success: boolean;
  error?: string;
  message?: string;
  /** The computed plan (always returned on success, dry-run or executed). */
  plan?: DistributionRunPlan;
  /** Whether money was actually moved (true only when `confirm` was set). */
  executed?: boolean;
  /** Wallet-transaction ids created for each recipient credit (executed only). */
  transactionIds?: string[];
}

/**
 * Resolves and (optionally) executes a Layer-2 project-net distribution.
 *
 * Flow:
 *  1. Authn/authz: caller must hold group-write access on the owning org.
 *  2. Resolve the org's net-allocation tree into per-individual bps shares.
 *  3. Plan exact per-recipient cents via {@link planProjectNetDistribution}
 *     (largest-remainder, exact-sum; the org keeps any undistributed remainder).
 *  4. If `confirm !== true`: return the plan (DRY RUN — no money moves).
 *  5. If `confirm === true`: inside one transaction, lock + debit the project
 *     treasury by the distributed total and credit each recipient's settlement
 *     wallet, reusing the shared crediting helpers (`creditWalletCapital`).
 *
 * @param input See {@link RunProjectNetDistributionInput}.
 * @returns The plan plus execution outcome.
 */
export async function runProjectNetDistributionAction(
  input: RunProjectNetDistributionInput,
): Promise<RunProjectNetDistributionResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, error: 'You must be logged in to run a distribution.' };
  }

  // Distribution moves treasury funds; reuse the shared wallet limiter bucket.
  const check = await rateLimit(
    `wallet:${userId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(input.projectId)) return { success: false, error: 'Invalid project.' };
  if (!isUuid(input.groupId)) return { success: false, error: 'Invalid group.' };
  if (!Number.isInteger(input.netCents) || input.netCents <= 0) {
    return { success: false, error: 'Distribution amount must be a positive integer (in cents).' };
  }

  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, error: 'You do not have permission to run distributions for this org.' };
  }

  // The resource row is authoritative for the project guard.
  const [projectRow] = await db
    .select({ type: resources.type, ownerId: resources.ownerId })
    .from(resources)
    .where(eq(resources.id, input.projectId))
    .limit(1);
  if (!projectRow) return { success: false, error: 'Project not found.' };
  if (projectRow.type !== RESOURCE_TYPE_PROJECT) {
    return { success: false, error: 'Distributions can only be run against a project.' };
  }
  if (projectRow.ownerId !== input.groupId) {
    return { success: false, error: 'Project is not owned by the specified org.' };
  }

  // Resolve the org's net-allocation tree into per-individual bps shares.
  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, input.groupId))
    .limit(1);
  if (!group) return { success: false, error: 'Org not found.' };

  const tree: NetAllocationTree = parseNetAllocationTree(
    (group.metadata ?? {}) as Record<string, unknown>,
  );
  if (tree.rules.length === 0) {
    return { success: false, error: 'This org has no net-allocation tree to distribute by.' };
  }
  const classMembers = await getGroupMembersByClass(input.groupId);
  const resolved = resolveNetAllocation(tree, classMembers);

  let plan: DistributionRunPlan;
  try {
    plan = planProjectNetDistribution(input.netCents, resolved);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to plan distribution.' };
  }

  if (plan.credits.length === 0 || plan.distributedCents === 0) {
    return {
      success: false,
      error: 'The allocation tree resolves to no recipients (empty classes / zero shares).',
      plan,
    };
  }

  // DRY RUN — return the plan without moving money (money-safety default).
  if (input.confirm !== true) {
    return {
      success: true,
      executed: false,
      message: 'Dry run: review the plan, then re-run with confirm to execute.',
      plan,
    };
  }

  // EXECUTE — debit treasury, credit recipients, all in one transaction.
  const projectWallet = await getProjectWalletForResource(input.projectId);
  if (!projectWallet) {
    return { success: false, error: 'This project has no treasury wallet yet.', plan };
  }

  // Pre-resolve recipient settlement wallets (creation is idempotent and outside
  // the debit transaction to avoid holding the row lock during agent lookups).
  const recipientWallets = new Map<string, string>();
  for (const credit of plan.credits) {
    const wallet = await getSettlementWalletForAgent(credit.recipientId);
    recipientWallets.set(credit.recipientId, wallet.id);
  }

  try {
    const transactionIds = await db.transaction(async (tx) => {
      // Lock the project wallet row before reading balance/frozen state.
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${projectWallet.id} FOR UPDATE`);

      const [locked] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.id, projectWallet.id))
        .limit(1);
      if (!locked) throw new Error('Project wallet disappeared mid-transaction.');
      if (locked.type !== 'project') throw new Error('Wallet is not a project treasury wallet.');
      if (locked.isFrozen) throw new Error('Cannot distribute from a frozen treasury.');
      if (locked.balanceCents < plan.distributedCents) {
        throw new Error(
          `Insufficient treasury balance: have ${locked.balanceCents} cents, need ${plan.distributedCents} cents`,
        );
      }

      // Consume capital lots for the distributed total (not the org-keep cents),
      // keeping payout-eligibility accounting consistent. These lots leave the
      // treasury — they are re-opened as fresh lots on the recipient wallets.
      await consumeWalletCapital(tx, projectWallet.id, locked.balanceCents, plan.distributedCents);

      // Debit the treasury by the distributed total. The org-keep remainder
      // intentionally stays in the wallet.
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} - ${plan.distributedCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, projectWallet.id));

      const createdTxIds: string[] = [];

      for (const credit of plan.credits) {
        const recipientWalletId = recipientWallets.get(credit.recipientId)!;

        // Credit the recipient wallet balance.
        await tx
          .update(wallets)
          .set({
            balanceCents: sql`${wallets.balanceCents} + ${credit.amountCents}`,
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, recipientWalletId));

        // Ledger entry — distribution leg from project to recipient.
        const [ledgerEntry] = await tx
          .insert(ledger)
          .values({
            verb: 'transact',
            subjectId: input.groupId,
            objectId: credit.recipientId,
            objectType: 'agent',
            isActive: true,
            metadata: {
              source: 'project-net-distribution',
              interactionType: 'project-distribution',
              projectResourceId: input.projectId,
              fromWalletId: projectWallet.id,
              toWalletId: recipientWalletId,
              amountCents: credit.amountCents,
              bps: credit.bps,
            },
          } as NewLedgerEntry)
          .returning();

        // Wallet transaction — the distribution credit leg.
        const [payoutTx] = await tx
          .insert(walletTransactions)
          .values({
            type: DISTRIBUTION_TX_TYPE,
            fromWalletId: projectWallet.id,
            toWalletId: recipientWalletId,
            amountCents: credit.amountCents,
            feeCents: 0,
            currency: locked.currency,
            description: `Project net distribution ${input.projectId}`,
            referenceType: 'project',
            referenceId: input.projectId,
            ledgerEntryId: ledgerEntry.id,
            status: 'completed',
            metadata: {
              source: 'project-net-distribution',
              projectResourceId: input.projectId,
              recipientId: credit.recipientId,
              bps: credit.bps,
            },
          })
          .returning({ id: walletTransactions.id });

        // Re-open the share as a cleared capital lot on the recipient wallet so
        // it is immediately payout-eligible (the funds already cleared in-system).
        await creditWalletCapital(tx, recipientWalletId, credit.amountCents, {
          settlementStatus: 'cleared',
          availableOn: null,
          sourceType: 'project-net-distribution',
          sourceTransactionId: payoutTx.id,
          metadata: {
            projectResourceId: input.projectId,
            recipientId: credit.recipientId,
            bps: credit.bps,
          },
        });

        createdTxIds.push(payoutTx.id);
      }

      return createdTxIds;
    });

    emitDomainEvent({
      eventType: EVENT_TYPES.WALLET_PAYOUT,
      entityType: 'wallet',
      entityId: input.projectId,
      actorId: userId,
      payload: {
        projectId: input.projectId,
        groupId: input.groupId,
        distributedCents: plan.distributedCents,
        recipientCount: plan.credits.length,
        distribution: true,
      },
    }).catch(() => {});

    return {
      success: true,
      executed: true,
      message: `Distributed ${plan.distributedCents} cents across ${plan.credits.length} recipients.`,
      plan,
      transactionIds,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Distribution run failed.',
      plan,
    };
  }
}
