'use server';

/**
 * Group treasury ledger — the CONSOLIDATED transaction view across a group's
 * whole treasury tree: its main settlement wallet, every named fund, every
 * project treasury, and every subgroup's settlement/fund/project wallets
 * (recursive `agents.parent_id`).
 *
 * Backlog B10: a job cash payout debits the PROJECT wallet, so a
 * group-settlement-wallet-only view (the old `getTransactionHistoryAction`,
 * which actually read the VIEWER's personal wallet) never showed it. This
 * action resolves the full wallet set, then classifies each transaction as an
 * external inflow, an external outflow, or an internal treasury-to-treasury
 * move (funding a fund/project — excluded from revenue/expense so nothing
 * double-counts), attributing every leg to the specific wallet that moved
 * (e.g. "Build Shed project → payout").
 *
 * Authority: a manager (creator/admin of the group) sees the whole tree; an
 * ordinary member sees only the group's main settlement-wallet legs (parity
 * with `getGroupWalletAction`, which lets members read the group balance).
 */

import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { agents, ledger, resources, wallets, walletTransactions } from '@/db/schema';
import { getGroupSubtreeIds } from '@/lib/queries/stakes';
import {
  classifyTreasuryLeg,
  resolveVisibleTreasuryWalletIds,
  EXPORT_MAX_ROWS,
  type ClassifiedTreasuryLeg,
  type TreasuryScopeKind,
  type TreasuryWalletScope,
} from '@/lib/treasury-ledger';
import { getCurrentUserId, canManageWalletOwner } from './helpers';
import { isUuid } from './types';

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

/** Zeroed window aggregate, for the no-treasury-wallet short circuit. */
const EMPTY_TOTALS = {
  inflowCents: 0,
  outflowCents: 0,
  netCents: 0,
  inflowCount: 0,
  outflowCount: 0,
} as const;

/** One consolidated treasury transaction, attributed to the wallet that moved. */
export interface TreasuryLedgerEntry {
  id: string;
  type: string;
  description: string | null;
  status: string;
  createdAt: string;
  /** Always-positive transaction amount, in cents. */
  grossAmountCents: number;
  /** Treasury-signed: `+` inflow, `-` outflow, `0` internal. */
  signedAmountCents: number;
  direction: 'in' | 'out' | 'internal';
  /** The in-set treasury wallet this leg is attributed to. */
  scopeKind: TreasuryScopeKind;
  scopeLabel: string;
  /** The other side: an external owner name (in/out) or the other treasury wallet (internal). */
  counterpartyLabel: string | null;
}

/** Inflow/outflow split for one transaction type (for the P&L report). */
export interface TreasuryTypeTotal {
  type: string;
  inflowCents: number;
  outflowCents: number;
}

export interface GroupTreasuryLedger {
  /** True when the viewer manages the group (full tree) vs. a member (group-only). */
  canManageTree: boolean;
  entries: TreasuryLedgerEntry[];
  total: number;
  /**
   * Aggregate over the whole matching window (not just this page).
   *
   * `inflowCount`/`outflowCount` are window-wide too: the tab's "Based on N
   * transactions" caption used to count the rendered PAGE, so a month with more
   * activity than one page under-reported its own transaction count (audit
   * T-03) — and for a member it counted only the rows they could see, next to a
   * tree-wide dollar figure.
   */
  totals: {
    inflowCents: number;
    outflowCents: number;
    netCents: number;
    inflowCount: number;
    outflowCount: number;
  };
  /** Inflow/outflow broken down by transaction type over the whole window. */
  byType: TreasuryTypeTotal[];
}

interface ScopeWalletRow {
  walletId: string;
  kind: TreasuryScopeKind;
  label: string;
  ownerId: string;
}

/**
 * Resolves every wallet in the group's treasury tree with a display label:
 * the group's settlement wallet plus every fund, project, and subgroup wallet.
 *
 * This is the CLASSIFICATION set and is viewer-INDEPENDENT by design (audit
 * T1-1). It used to be truncated to the group's own settlement wallet for
 * non-managers, and because the same list doubled as the internal/external
 * predicate, a treasury -> fund move had one side in-set for a member and both
 * sides in-set for an admin. The member's P&L therefore booked internal
 * transfers as BOTH revenue and expense (MAB, July 2026: the member saw
 * -$41.15 where the admin saw +$1.21 — a sign-flipped statement on the only
 * financial surface non-admins can see).
 *
 * Which wallets' ROWS a viewer may read is a separate decision — see
 * `resolveVisibleTreasuryWalletIds`.
 */
async function resolveTreasuryWalletScopes(groupId: string): Promise<ScopeWalletRow[]> {
  // The group's own settlement wallet (owner-scoped, resource_id IS NULL).
  const groupAgent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, groupId))
    .limit(1);
  const groupName = groupAgent[0]?.name ?? 'Group';

  const scopes: ScopeWalletRow[] = [];

  const [groupSettlement] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.ownerId, groupId), eq(wallets.type, 'group'), isNull(wallets.resourceId)))
    .limit(1);
  if (groupSettlement) {
    scopes.push({ walletId: groupSettlement.id, kind: 'group', label: `${groupName} treasury`, ownerId: groupId });
  }

  // Full tree: the group + every descendant subgroup agent.
  const subtreeIds = await getGroupSubtreeIds(groupId);
  const subgroupIds = subtreeIds.filter((id) => id !== groupId);

  // Subgroup settlement wallets (owner-scoped) with agent names.
  if (subgroupIds.length > 0) {
    const subgroupWallets = await db
      .select({ walletId: wallets.id, ownerId: wallets.ownerId, name: agents.name })
      .from(wallets)
      .innerJoin(agents, eq(wallets.ownerId, agents.id))
      .where(
        and(inArray(wallets.ownerId, subgroupIds), eq(wallets.type, 'group'), isNull(wallets.resourceId)),
      );
    for (const row of subgroupWallets) {
      scopes.push({
        walletId: row.walletId,
        kind: 'subgroup',
        label: `${row.name} treasury`,
        ownerId: row.ownerId,
      });
    }
  }

  // Project + fund wallets: resource-bound (`type='project'`), owned by any
  // agent in the tree. `metadata.walletKind='fund'` discriminates funds from
  // real project treasuries; the label comes from the bound resource's name.
  const resourceWallets = await db
    .select({
      walletId: wallets.id,
      ownerId: wallets.ownerId,
      walletKind: sql<string | null>`${wallets.metadata}->>'walletKind'`,
      resourceName: resources.name,
    })
    .from(wallets)
    .leftJoin(resources, eq(wallets.resourceId, resources.id))
    .where(and(inArray(wallets.ownerId, subtreeIds), eq(wallets.type, 'project')));

  for (const row of resourceWallets) {
    const isFund = row.walletKind === 'fund';
    scopes.push({
      walletId: row.walletId,
      kind: isFund ? 'fund' : 'project',
      label: isFund
        ? `${row.resourceName ?? 'Fund'} fund`
        : `${row.resourceName ?? 'Project'} project`,
      ownerId: row.ownerId,
    });
  }

  return scopes;
}

/**
 * Consolidated treasury transaction ledger for a group, spanning its main
 * treasury plus (for managers) every fund, project, and subgroup wallet.
 *
 * @param groupId - The group agent UUID.
 * @param options - Pagination (`limit`/`offset`) and an optional `sinceIso`
 *   lower bound (used by the tab's month-to-date revenue/expense cards).
 * @returns The page of attributed entries, the total row count, and treasury
 *   inflow/outflow/net totals over the whole matching window.
 * @example
 * ```ts
 * const res = await getGroupTreasuryLedgerAction(groupId, { limit: 20 });
 * ```
 */
export async function getGroupTreasuryLedgerAction(
  groupId: string,
  options?: {
    limit?: number;
    offset?: number;
    sinceIso?: string;
    untilIso?: string;
    /** Raises the row ceiling to {@link EXPORT_MAX_ROWS} for a CSV export. */
    forExport?: boolean;
  },
): Promise<{ success: boolean; ledger?: GroupTreasuryLedger; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, error: 'You must be logged in to view the treasury ledger.' };
  }
  if (!isUuid(groupId)) {
    return { success: false, error: 'Invalid group.' };
  }

  try {
    const canManageTree = await canManageWalletOwner(userId, groupId);

    if (!canManageTree) {
      // Members still need an active membership edge (parity with getGroupWalletAction).
      const membership = await db.query.ledger.findFirst({
        where: and(
          eq(ledger.subjectId, userId),
          eq(ledger.objectId, groupId),
          eq(ledger.isActive, true),
        ),
        columns: { id: true, verb: true },
      });
      if (!membership || (membership.verb !== 'join' && membership.verb !== 'belong')) {
        return { success: false, error: 'You must be a member of this group to view its treasury.' };
      }
    }

    const scopes = await resolveTreasuryWalletScopes(groupId);
    if (scopes.length === 0) {
      return {
        success: true,
        ledger: {
          canManageTree,
          entries: [],
          total: 0,
          totals: EMPTY_TOTALS,
          byType: [],
        },
      };
    }

    // CLASSIFICATION set: the whole treasury tree, for EVERY viewer. This map
    // is what `classifyTreasuryLeg` reads, so a group -> fund/project move is
    // `internal` (net-zero) regardless of who is looking (audit T1-1).
    const scopeByWalletId = new Map<string, TreasuryWalletScope>(
      scopes.map((s) => [s.walletId, { walletId: s.walletId, kind: s.kind, label: s.label, ownerId: s.ownerId }]),
    );
    const treasuryWalletIds = scopes.map((s) => s.walletId);
    // VISIBILITY set: which wallets' individual rows this viewer may read. May
    // be empty (a group with no settlement wallet yet, seen by a member) — that
    // suppresses the ROW list only. Totals below still run over the whole tree,
    // because one group has one P&L no matter who is asking (audit T1-1).
    const walletIds = resolveVisibleTreasuryWalletIds(scopes, canManageTree);
    const hasVisibleWallets = walletIds.length > 0;

    // An export pulls the whole selected range in one request; the paged UI
    // stays capped at MAX_PAGE_LIMIT (audit T1-2).
    const rowCeiling = options?.forExport ? EXPORT_MAX_ROWS : MAX_PAGE_LIMIT;
    const limit = Math.min(Math.max(1, options?.limit ?? DEFAULT_PAGE_LIMIT), rowCeiling);
    const offset = Math.max(0, options?.offset ?? 0);
    const since = options?.sinceIso ? new Date(options.sinceIso) : null;
    const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;
    const until = options?.untilIso ? new Date(options.untilIso) : null;
    const untilValid = until && !Number.isNaN(until.getTime()) ? until : null;

    // Date bounds apply identically to the row window and the totals window, so
    // the rendered list and the P&L above it always describe the same period.
    const dateFilters: SQL[] = [];
    if (sinceValid) dateFilters.push(gte(walletTransactions.createdAt, sinceValid));
    if (untilValid) dateFilters.push(lte(walletTransactions.createdAt, untilValid));

    /** Rows this viewer may READ (visibility-scoped). */
    const baseFilter = and(
      or(
        inArray(walletTransactions.fromWalletId, walletIds),
        inArray(walletTransactions.toWalletId, walletIds),
      ),
      ...dateFilters,
    );

    // Owner-name joins for external counterparties (the non-treasury side).
    const fromWallets = db
      .select({ id: wallets.id, ownerId: wallets.ownerId })
      .from(wallets)
      .as('tl_from_wallets');
    const toWallets = db
      .select({ id: wallets.id, ownerId: wallets.ownerId })
      .from(wallets)
      .as('tl_to_wallets');
    const fromOwner = db.select({ id: agents.id, name: agents.name }).from(agents).as('tl_from_owner');
    const toOwner = db.select({ id: agents.id, name: agents.name }).from(agents).as('tl_to_owner');

    const [countRow] = hasVisibleWallets
      ? await db
          .select({ value: sql<number>`count(*)::int` })
          .from(walletTransactions)
          .where(baseFilter)
      : [{ value: 0 }];
    const total = countRow?.value ?? 0;

    // Treasury inflow/outflow over the WHOLE window (internal moves excluded):
    // aggregated in SQL so the tab's revenue/expense cards are correct even
    // though only one page of rows is rendered.
    //
    // The in-set predicate is the FULL TREE for every viewer — a P&L is an
    // aggregate and carries no payee detail, and a group must not report two
    // different net incomes depending on who asks (audit T1-1). The row list
    // above stays scoped to `walletIds`.
    const inSetFrom = inArray(walletTransactions.fromWalletId, treasuryWalletIds);
    const inSetTo = inArray(walletTransactions.toWalletId, treasuryWalletIds);
    const totalsWindowFilter = and(
      or(
        inArray(walletTransactions.fromWalletId, treasuryWalletIds),
        inArray(walletTransactions.toWalletId, treasuryWalletIds),
      ),
      ...dateFilters,
    );
    // One expression per direction, reused for the sums and the counts so a
    // figure and its "based on N transactions" caption can never disagree.
    const isInflow = sql`(${inSetTo}) AND (${walletTransactions.fromWalletId} IS NULL OR NOT (${inSetFrom}))`;
    const isOutflow = sql`(${inSetFrom}) AND (${walletTransactions.toWalletId} IS NULL OR NOT (${inSetTo}))`;
    const [totalsRow] = await db
      .select({
        inflow: sql<number>`COALESCE(SUM(CASE WHEN ${isInflow} THEN ${walletTransactions.amountCents} ELSE 0 END), 0)::int`,
        outflow: sql<number>`COALESCE(SUM(CASE WHEN ${isOutflow} THEN ${walletTransactions.amountCents} ELSE 0 END), 0)::int`,
        inflowCount: sql<number>`COUNT(*) FILTER (WHERE ${isInflow})::int`,
        outflowCount: sql<number>`COUNT(*) FILTER (WHERE ${isOutflow})::int`,
      })
      .from(walletTransactions)
      .where(and(totalsWindowFilter, eq(walletTransactions.status, 'completed')));
    const inflowCents = Number(totalsRow?.inflow ?? 0);
    const outflowCents = Number(totalsRow?.outflow ?? 0);
    const inflowCount = Number(totalsRow?.inflowCount ?? 0);
    const outflowCount = Number(totalsRow?.outflowCount ?? 0);

    // Inflow/outflow split per transaction type — the P&L report's line items.
    const byTypeRows = await db
      .select({
        type: walletTransactions.type,
        inflow: sql<number>`COALESCE(SUM(CASE WHEN ${isInflow} THEN ${walletTransactions.amountCents} ELSE 0 END), 0)::int`,
        outflow: sql<number>`COALESCE(SUM(CASE WHEN ${isOutflow} THEN ${walletTransactions.amountCents} ELSE 0 END), 0)::int`,
      })
      .from(walletTransactions)
      .where(and(totalsWindowFilter, eq(walletTransactions.status, 'completed')))
      .groupBy(walletTransactions.type);
    const byType: TreasuryTypeTotal[] = byTypeRows
      .map((r) => ({ type: r.type, inflowCents: Number(r.inflow ?? 0), outflowCents: Number(r.outflow ?? 0) }))
      .filter((r) => r.inflowCents > 0 || r.outflowCents > 0)
      .sort((a, b) => b.inflowCents + b.outflowCents - (a.inflowCents + a.outflowCents));

    const rows = hasVisibleWallets
      ? await db
          .select({
            id: walletTransactions.id,
            type: walletTransactions.type,
            amountCents: walletTransactions.amountCents,
            description: walletTransactions.description,
            status: walletTransactions.status,
            createdAt: walletTransactions.createdAt,
            fromWalletId: walletTransactions.fromWalletId,
            toWalletId: walletTransactions.toWalletId,
            fromOwnerName: fromOwner.name,
            toOwnerName: toOwner.name,
          })
          .from(walletTransactions)
          .leftJoin(fromWallets, eq(walletTransactions.fromWalletId, fromWallets.id))
          .leftJoin(fromOwner, eq(fromWallets.ownerId, fromOwner.id))
          .leftJoin(toWallets, eq(walletTransactions.toWalletId, toWallets.id))
          .leftJoin(toOwner, eq(toWallets.ownerId, toOwner.id))
          .where(baseFilter)
          .orderBy(sql`${walletTransactions.createdAt} DESC`)
          .limit(limit)
          .offset(offset)
      : [];

    const entries: TreasuryLedgerEntry[] = rows.map((r) => {
      const classified: ClassifiedTreasuryLeg = classifyTreasuryLeg(
        { fromWalletId: r.fromWalletId, toWalletId: r.toWalletId, amountCents: r.amountCents },
        scopeByWalletId,
      );

      let scope: TreasuryWalletScope | null;
      let counterpartyLabel: string | null;
      if (classified.direction === 'in') {
        scope = classified.toScope;
        counterpartyLabel = r.fromOwnerName ?? null;
      } else if (classified.direction === 'out') {
        scope = classified.fromScope;
        counterpartyLabel = r.toOwnerName ?? null;
      } else {
        // internal: attribute to the source, name the destination treasury.
        scope = classified.fromScope ?? classified.toScope;
        counterpartyLabel = classified.toScope?.label ?? null;
      }

      return {
        id: r.id,
        type: r.type,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        grossAmountCents: Math.abs(r.amountCents),
        signedAmountCents: classified.signedAmountCents,
        direction: classified.direction,
        scopeKind: scope?.kind ?? 'group',
        scopeLabel: scope?.label ?? 'Treasury',
        counterpartyLabel,
      };
    });

    return {
      success: true,
      ledger: {
        canManageTree,
        entries,
        total,
        totals: {
          inflowCents,
          outflowCents,
          netCents: inflowCents - outflowCents,
          inflowCount,
          outflowCount,
        },
        byType,
      },
    };
  } catch (error) {
    console.error('getGroupTreasuryLedgerAction failed:', error);
    return { success: false, error: 'Unable to load the treasury ledger.' };
  }
}
