'use server';

/**
 * Project budgeting rollup — the SERVER aggregation that feeds the pure
 * {@link computeProjectBudget}/{@link rollUpBudgets} core (backlog B14).
 *
 * Gathers, per project, the four cost sources the budget reconciles against the
 * authored target (`metadata.budget`, stored in DOLLARS):
 *   (a) JOB COSTS — committed (planned fixed pay + hourly ceilings across the
 *       project's jobs, owner-agnostic via `getJobsByProjectId`) and paid (the
 *       authoritative `job-cash-payout` ledger sum, which debits the project
 *       wallet).
 *   (b) PURCHASES — on-platform buys attributed to the project
 *       (`wallet_transactions.metadata.projectId`).
 *   (c) CARD EXPENSES — spend on the project's FA-scoped Issuing card
 *       (best-effort; 0 while Treasury/Issuing is dormant).
 *   (+) EXPENSES — first-class external `project_expense` debits.
 *
 * Then rolls project → subgroup → group → parent group.
 *
 * Authority: manage/write access over the owning agent (cascades to parent-group
 * admins via `hasGroupWriteAccess`), so a parent admin sees a subgroup project's
 * budget.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, ledger, resources, walletTransactions } from '@/db/schema';
import { getGroupSubtreeIds } from '@/lib/queries/stakes';
import { getJobsByProjectId } from '@/lib/queries/resources';
import { getProjectWalletForResource } from '@/lib/wallet';
import { sumIssuingSpendForCardholder } from '@/lib/stripe-treasury';
import { hasGroupWriteAccess } from '@/app/actions/resource-creation/helpers';
import {
  computeProjectBudget,
  rollUpBudgets,
  type BudgetAgentNode,
  type ProjectBudgetSummary,
  type BudgetRollupNode,
  type ProjectCostInputs,
} from '@/lib/budget-rollup';
import { getCurrentUserId } from './helpers';
import { isUuid } from './types';

const JOB_CASH_PAYOUT_INTERACTION = 'job-cash-payout';
const PROJECT_EXPENSE_TX_TYPE = 'project_expense';
/** Purchase transaction types that can be attributed to a project as a buy. */
const PURCHASE_TX_TYPES = ['marketplace_purchase', 'event_ticket'] as const;

interface ProjectRow {
  id: string;
  name: string;
  ownerId: string;
  metadata: Record<string, unknown>;
}

function readBudgetCents(metadata: Record<string, unknown>): number | null {
  const budget = metadata.budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return null;
  return Math.max(0, Math.round(budget * 100));
}

/** Reads a numeric-ish metadata field, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Gathers a project's four cost components from the DB (+ best-effort Issuing
 * card spend), producing the pure-lib input. `sinceEpoch` optionally bounds the
 * card-spend read for date-ranged reports.
 */
async function gatherProjectCostInputs(
  project: ProjectRow,
  options?: { sinceEpoch?: number },
): Promise<ProjectCostInputs> {
  const budgetCents = readBudgetCents(project.metadata);

  // (a) Job costs — committed from job pay metadata; paid from the ledger.
  const jobs = await getJobsByProjectId(project.id);
  let jobsCommittedCents = 0;
  for (const job of jobs) {
    const m = (job.metadata ?? {}) as Record<string, unknown>;
    const payKind = m.payKind;
    if (payKind === 'fixed') {
      const amount = num(m.payAmountCents);
      if (amount > 0) jobsCommittedCents += amount;
    } else if (payKind === 'hourly') {
      const rate = num(m.hourlyRateCents);
      const maxHours = num(m.maxHours);
      if (rate > 0 && maxHours > 0) jobsCommittedCents += Math.round(rate * maxHours);
    }
  }

  const [paidRow] = await db
    .select({
      sum: sql<number>`COALESCE(SUM((${ledger.metadata}->>'amountCents')::int), 0)::int`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.verb, 'earn'),
        eq(ledger.isActive, true),
        sql`${ledger.metadata}->>'interactionType' = ${JOB_CASH_PAYOUT_INTERACTION}`,
        sql`${ledger.metadata}->>'projectId' = ${project.id}`,
      ),
    );
  const jobsPaidCents = Number(paidRow?.sum ?? 0);

  // (b) On-platform purchases attributed to the project (buyer-side metadata).
  const [purchaseRow] = await db
    .select({
      sum: sql<number>`COALESCE(SUM(${walletTransactions.amountCents}), 0)::int`,
    })
    .from(walletTransactions)
    .where(
      and(
        inArray(walletTransactions.type, [...PURCHASE_TX_TYPES]),
        eq(walletTransactions.status, 'completed'),
        sql`${walletTransactions.metadata}->>'projectId' = ${project.id}`,
      ),
    );
  const purchasesCents = Number(purchaseRow?.sum ?? 0);

  // (+) First-class external project expenses (debits out of the project wallet).
  const [expenseRow] = await db
    .select({
      sum: sql<number>`COALESCE(SUM(${walletTransactions.amountCents}), 0)::int`,
    })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.type, PROJECT_EXPENSE_TX_TYPE),
        eq(walletTransactions.referenceType, 'project'),
        eq(walletTransactions.referenceId, project.id),
        eq(walletTransactions.status, 'completed'),
      ),
    );
  const otherExpensesCents = Number(expenseRow?.sum ?? 0);

  // (c) FA-scoped Issuing card spend — best-effort; 0 while Treasury dormant.
  let cardExpensesCents = 0;
  const projectWallet = await getProjectWalletForResource(project.id);
  const walletMeta = (projectWallet?.metadata ?? {}) as Record<string, unknown>;
  const cardholderId = walletMeta.stripeIssuingCardholderId as string | undefined;
  const host = walletMeta.stripeHostConnectAccountId as string | undefined;
  if (cardholderId && host) {
    cardExpensesCents = await sumIssuingSpendForCardholder(host, cardholderId, {
      createdGteEpoch: options?.sinceEpoch,
    }).catch(() => 0);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    ownerAgentId: project.ownerId,
    budgetCents,
    jobsCommittedCents,
    jobsPaidCents,
    purchasesCents,
    cardExpensesCents,
    otherExpensesCents,
  };
}

async function fetchProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, projectId), isNull(resources.deletedAt)))
    .limit(1);
  if (!row || row.type !== 'project') return null;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Computes a single project's budget position (all four cost sources vs. the
 * authored target). Manage/write authority over the owning agent is required
 * (cascades to parent-group admins).
 *
 * @param {string} projectId - The `resources.id` of the project resource.
 * @param {{ sinceIso?: string }} [options] - Optional date lower bound for the card-spend component.
 * @returns {Promise<{ success: boolean; summary?: ProjectBudgetSummary; error?: string }>} The budget summary or error.
 * @example
 * ```ts
 * const { summary } = await getProjectBudgetSummaryAction(projectId);
 * ```
 */
export async function getProjectBudgetSummaryAction(
  projectId: string,
  options?: { sinceIso?: string },
): Promise<{ success: boolean; summary?: ProjectBudgetSummary; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(projectId)) return { success: false, error: 'Invalid project.' };

  try {
    const project = await fetchProject(projectId);
    if (!project) return { success: false, error: 'Project not found.' };

    const canView = project.ownerId === userId || (await hasGroupWriteAccess(userId, project.ownerId));
    if (!canView) {
      return { success: false, error: 'You are not allowed to view this project budget.' };
    }

    const sinceEpoch = parseSinceEpoch(options?.sinceIso);
    const inputs = await gatherProjectCostInputs(project, { sinceEpoch });
    return { success: true, summary: computeProjectBudget(inputs) };
  } catch (error) {
    console.error('getProjectBudgetSummaryAction failed:', error);
    return { success: false, error: 'Unable to load the project budget.' };
  }
}

/**
 * Rolls every project in a group's subtree up into project → subgroup → group
 * totals. Manage/write authority over the group is required.
 *
 * @param {string} groupId - The root group agent UUID.
 * @param {{ sinceIso?: string }} [options] - Optional date lower bound for the card-spend component.
 * @returns {Promise<{ success: boolean; rollup?: BudgetRollupNode; error?: string }>} The root rollup node or error.
 * @example
 * ```ts
 * const { rollup } = await getGroupBudgetRollupAction(groupId);
 * ```
 */
export async function getGroupBudgetRollupAction(
  groupId: string,
  options?: { sinceIso?: string },
): Promise<{ success: boolean; rollup?: BudgetRollupNode; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(groupId)) return { success: false, error: 'Invalid group.' };

  try {
    const canView = groupId === userId || (await hasGroupWriteAccess(userId, groupId));
    if (!canView) {
      return { success: false, error: 'You are not allowed to view this group budget.' };
    }

    const subtreeIds = await getGroupSubtreeIds(groupId);
    if (subtreeIds.length === 0) {
      return { success: false, error: 'Group not found.' };
    }

    // Agent tree nodes (root = group, descendants = subgroups).
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, parentId: agents.parentId })
      .from(agents)
      .where(and(inArray(agents.id, subtreeIds), isNull(agents.deletedAt)));
    const agentNodes: BudgetAgentNode[] = agentRows.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      parentId: a.parentId ?? null,
      kind: a.id === groupId ? 'group' : 'subgroup',
    }));

    // Every project owned anywhere in the subtree.
    const projectRows = await db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        ownerId: resources.ownerId,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(
        and(
          eq(resources.type, 'project'),
          inArray(resources.ownerId, subtreeIds),
          isNull(resources.deletedAt),
        ),
      );

    const sinceEpoch = parseSinceEpoch(options?.sinceIso);
    const summaries: ProjectBudgetSummary[] = [];
    for (const row of projectRows) {
      const project: ProjectRow = {
        id: row.id,
        name: row.name,
        ownerId: row.ownerId,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      };
      const inputs = await gatherProjectCostInputs(project, { sinceEpoch });
      summaries.push(computeProjectBudget(inputs));
    }

    const rollup = rollUpBudgets(summaries, agentNodes, groupId);
    if (!rollup) return { success: false, error: 'Group not found.' };

    return { success: true, rollup };
  } catch (error) {
    console.error('getGroupBudgetRollupAction failed:', error);
    return { success: false, error: 'Unable to load the group budget rollup.' };
  }
}

/** Parses an ISO date into a Unix-seconds lower bound, or undefined. */
function parseSinceEpoch(sinceIso?: string): number | undefined {
  if (!sinceIso) return undefined;
  const date = new Date(sinceIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
}
