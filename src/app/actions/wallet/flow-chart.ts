"use server";

/**
 * Treasury Allocations flow data (2026-07-10).
 *
 * Feeds the Treasury tab's "Allocations" flow chart: how funds actually flow
 * among the entities — project wallets → expenses → the group treasury
 * (completion sweeps), treasury → funds, treasury → member payouts, subgroup
 * treasuries feeding the org, and the configured net-allocation splits.
 * Realized amounts come from `wallet_transactions`; structural splits come
 * from the org's net-allocation tree. Member-visible (same audience as the
 * Stake tab — it explains the group's economics, it moves nothing).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources, wallets } from "@/db/schema";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import { isUuid } from "@/app/actions/interactions/types";
import { parseNetAllocationTree } from "@/lib/net-allocation";

export interface FlowNode {
  id: string;
  name: string;
  balanceCents: number;
}

export interface ProjectFlowNode extends FlowNode {
  /** Total expense debits recorded from this project's wallet. */
  expenseCents: number;
  /** Total transferred from this project's wallet into the group treasury. */
  sweptCents: number;
  /** Total apportioned from the group treasury into this project's wallet. */
  fundedCents: number;
  completed: boolean;
}

export interface AllocationSplit {
  label: string;
  bps: number;
}

export interface TreasuryFlowData {
  group: FlowNode;
  projects: ProjectFlowNode[];
  subgroups: FlowNode[];
  funds: FlowNode[];
  /** Total moved treasury → fund wallets. */
  toFundsCents: number;
  /** Total paid treasury → personal wallets (job payouts, distributions). */
  toMembersCents: number;
  /** Configured net-allocation splits on the org (structural, bps). */
  allocations: AllocationSplit[];
}

/** Sum of transactions between two wallets (completed only). */
async function sumBetween(fromWalletId: string, toWalletId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM wallet_transactions
    WHERE from_wallet_id = ${fromWalletId}::uuid AND to_wallet_id = ${toWalletId}::uuid
      AND status = 'completed'
  `)) as Array<{ total: string | number }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Resolves the flow-chart dataset for a group. Members and admins only —
 * read-only, no wallet is ever created here.
 */
export async function getTreasuryFlowData(groupId: string): Promise<TreasuryFlowData | null> {
  const userId = await getCurrentUserId();
  if (!userId || !isUuid(groupId)) return null;

  const { isGroupAdmin, isGroupMember } = await import("@/app/actions/group-admin");
  const [isAdmin, isMember] = await Promise.all([
    isGroupAdmin(userId, groupId),
    isGroupMember(userId, groupId),
  ]);
  if (!isAdmin && !isMember && userId !== groupId) return null;

  const [group] = await db
    .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);
  if (!group) return null;

  // Group treasury (never created here — absent reads as zero).
  const [treasury] = await db
    .select({ id: wallets.id, balanceCents: wallets.balanceCents })
    .from(wallets)
    .where(and(eq(wallets.ownerId, groupId), eq(wallets.type, "group"), isNull(wallets.resourceId)))
    .limit(1);

  // Direct subgroup treasuries.
  const subgroupRows = (await db.execute(sql`
    SELECT a.id, a.name, COALESCE(w.balance_cents, 0) AS balance
    FROM agents a
    LEFT JOIN wallets w ON w.owner_id = a.id AND w.type = 'group' AND w.resource_id IS NULL
    WHERE a.parent_id = ${groupId}::uuid AND a.deleted_at IS NULL AND a.type <> 'person'
    ORDER BY a.name
  `)) as Array<{ id: string; name: string; balance: string | number }>;

  // Project wallets on the group's projects (resource-bound), with realized
  // expense + sweep totals.
  const projectRows = (await db.execute(sql`
    SELECT r.id, r.name, w.id AS wallet_id, COALESCE(w.balance_cents, 0) AS balance,
           COALESCE(r.metadata->>'status', 'active') AS status,
           COALESCE((
             SELECT SUM(t.amount_cents) FROM wallet_transactions t
             WHERE t.from_wallet_id = w.id AND t.type = 'project_expense' AND t.status = 'completed'
           ), 0) AS expense_cents
    FROM resources r
    JOIN wallets w ON w.resource_id = r.id
    WHERE r.owner_id = ${groupId}::uuid AND r.type = 'project' AND r.deleted_at IS NULL
    ORDER BY r.name
    LIMIT 20
  `)) as Array<{ id: string; name: string; wallet_id: string; balance: string | number; status: string; expense_cents: string | number }>;

  const projects: ProjectFlowNode[] = [];
  for (const row of projectRows) {
    const [swept, funded] = treasury
      ? await Promise.all([
          sumBetween(row.wallet_id, treasury.id),
          sumBetween(treasury.id, row.wallet_id),
        ])
      : [0, 0];
    projects.push({
      id: row.id,
      name: row.name,
      balanceCents: Number(row.balance ?? 0),
      expenseCents: Number(row.expense_cents ?? 0),
      sweptCents: swept,
      fundedCents: funded,
      completed: row.status === "completed",
    });
  }

  // Fund wallets (named sub-pools of the treasury).
  const fundRows = (await db.execute(sql`
    SELECT r.id, r.name, w.id AS wallet_id, COALESCE(w.balance_cents, 0) AS balance
    FROM resources r
    JOIN wallets w ON w.resource_id = r.id
    WHERE r.owner_id = ${groupId}::uuid AND r.deleted_at IS NULL
      AND r.metadata->>'resourceKind' = 'fund'
    ORDER BY r.name
    LIMIT 12
  `)) as Array<{ id: string; name: string; wallet_id: string; balance: string | number }>;

  let toFundsCents = 0;
  const funds: FlowNode[] = [];
  for (const row of fundRows) {
    if (treasury) toFundsCents += await sumBetween(treasury.id, row.wallet_id);
    funds.push({ id: row.id, name: row.name, balanceCents: Number(row.balance ?? 0) });
  }

  // Treasury → member payouts (transfers into personal wallets).
  let toMembersCents = 0;
  if (treasury) {
    const rows = (await db.execute(sql`
      SELECT COALESCE(SUM(t.amount_cents), 0) AS total
      FROM wallet_transactions t
      JOIN wallets pw ON pw.id = t.to_wallet_id AND pw.type = 'personal'
      WHERE t.from_wallet_id = ${treasury.id}::uuid AND t.status = 'completed'
    `)) as Array<{ total: string | number }>;
    toMembersCents = Number(rows[0]?.total ?? 0);
  }

  // Structural net-allocation splits configured on the org.
  const tree = parseNetAllocationTree((group.metadata ?? {}) as Record<string, unknown>);
  const allocations: AllocationSplit[] = tree.rules.map((rule) => ({
    label: rule.label ?? (rule.targetType === "class" ? `${rule.targetId} class` : rule.targetId.slice(0, 8)),
    bps: rule.bps,
  }));

  return {
    group: { id: group.id, name: group.name, balanceCents: Number(treasury?.balanceCents ?? 0) },
    projects,
    subgroups: subgroupRows.map((r) => ({ id: r.id, name: r.name, balanceCents: Number(r.balance ?? 0) })),
    funds,
    toFundsCents,
    toMembersCents,
    allocations,
  };
}
