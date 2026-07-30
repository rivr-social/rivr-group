/**
 * Treasury ledger classification (2026-07-14).
 *
 * A group's real financial picture is spread across MORE than its main
 * settlement wallet: named funds, per-project treasuries, and subgroup
 * treasuries all hold and move money that belongs to the group's tree. A job
 * cash payout, for example, debits the PROJECT wallet — so it never appeared in
 * a group-settlement-wallet-only transaction view (backlog B10: "$2 fixed
 * payout completed but NOT shown in Spirit treasury transactions").
 *
 * This module is the PURE core that classifies a single wallet transaction
 * relative to the SET of wallets that make up a group's treasury tree:
 *   - `in`       — money entered the treasury from outside (a sale, a deposit)
 *   - `out`      — money left the treasury to an external party (a job payout,
 *                  an external expense)
 *   - `internal` — money moved BETWEEN two treasury wallets (group -> fund,
 *                  group -> project); net-zero for the treasury as a whole and
 *                  therefore excluded from revenue/expense totals so funding a
 *                  project never double-counts as an expense.
 *
 * Keeping this DB-free makes the money math unit-testable in isolation; the
 * server action layers scope resolution + labeling on top.
 */

/** Which kind of treasury wallet a leg touches. */
export type TreasuryScopeKind = 'group' | 'subgroup' | 'fund' | 'project';

/** A wallet that belongs to the group's treasury tree, with its display label. */
export interface TreasuryWalletScope {
  /** The `wallets.id`. */
  walletId: string;
  /** Where this wallet sits in the treasury tree. */
  kind: TreasuryScopeKind;
  /** Human label, e.g. "Operations Fund" or "Spirit of the Front Range". */
  label: string;
  /** Owning agent id (group/subgroup) for the wallet. */
  ownerId: string;
}

/**
 * The wallets whose individual ROWS a viewer may read.
 *
 * The counterpart to {@link classifyTreasuryLeg}'s scope map, and deliberately
 * a DIFFERENT set (audit T1-1): a manager reads every leg in the tree, while an
 * ordinary member reads only the group's own settlement-wallet legs — but BOTH
 * lanes classify and total against the full tree, so one group reports one P&L.
 *
 * Collapsing the two concepts is what produced the defect: the member's
 * truncated wallet list doubled as the internal/external predicate, so a
 * group -> fund transfer looked external to a member (booked as revenue on the
 * way in AND an expense on the way out) and internal to an admin.
 *
 * @param scopes Every wallet in the group's treasury tree.
 * @param canManageTree Whether the viewer manages the group.
 * @returns Wallet ids whose rows the viewer may see.
 */
export function resolveVisibleTreasuryWalletIds(
  scopes: readonly TreasuryWalletScope[],
  canManageTree: boolean,
): string[] {
  if (canManageTree) return scopes.map((scope) => scope.walletId);
  return scopes.filter((scope) => scope.kind === 'group').map((scope) => scope.walletId);
}

/** Direction of a transaction leg relative to the treasury set. */
export type TreasuryLegDirection = 'in' | 'out' | 'internal';

/** Result of classifying one transaction against the treasury wallet set. */
export interface ClassifiedTreasuryLeg {
  direction: TreasuryLegDirection;
  /** Signed against the treasury: `+` inflow, `-` outflow, `0` internal. */
  signedAmountCents: number;
  /** The in-set source wallet, or `null` when the source is external. */
  fromScope: TreasuryWalletScope | null;
  /** The in-set destination wallet, or `null` when the destination is external. */
  toScope: TreasuryWalletScope | null;
}

/**
 * Classifies a single transaction leg relative to a group's treasury wallet
 * set. Callers only pass transactions that touch the set (at least one side
 * in-set); a transaction touching neither side is treated as `internal`
 * net-zero defensively so it can never inflate revenue/expense.
 *
 * @param leg - The transaction's `fromWalletId`/`toWalletId` (either may be
 *   `null` for an external-only leg, e.g. a `project_expense`) and its POSITIVE
 *   `amountCents`.
 * @param scopeByWalletId - Map of every in-set wallet id to its scope.
 * @returns The direction, treasury-signed amount, and the resolved scopes.
 */
export function classifyTreasuryLeg(
  leg: { fromWalletId: string | null; toWalletId: string | null; amountCents: number },
  scopeByWalletId: ReadonlyMap<string, TreasuryWalletScope>,
): ClassifiedTreasuryLeg {
  const fromScope = leg.fromWalletId ? scopeByWalletId.get(leg.fromWalletId) ?? null : null;
  const toScope = leg.toWalletId ? scopeByWalletId.get(leg.toWalletId) ?? null : null;
  const amount = Math.abs(leg.amountCents);

  const fromIn = fromScope !== null;
  const toIn = toScope !== null;

  if (fromIn && toIn) {
    return { direction: 'internal', signedAmountCents: 0, fromScope, toScope };
  }
  if (toIn) {
    return { direction: 'in', signedAmountCents: amount, fromScope: null, toScope };
  }
  if (fromIn) {
    return { direction: 'out', signedAmountCents: -amount, fromScope, toScope: null };
  }
  // Neither side in-set: not a treasury leg. Net-zero so totals stay correct.
  return { direction: 'internal', signedAmountCents: 0, fromScope: null, toScope: null };
}

/**
 * Hard ceiling on the rows a single treasury CSV export may contain.
 *
 * The export used to serialize whatever page was already on screen (20 rows)
 * under a bare "Export" label, so an accountant reconciling off-platform
 * silently lost everything older (audit T1-2). It now runs its own query over
 * the selected range; this bounds that query so one click can never pull an
 * unbounded table into memory. When a range exceeds it the UI must disclose the
 * truncation rather than emit a short file that looks complete.
 */
export const EXPORT_MAX_ROWS = 10_000;

/** Column order of the treasury CSV export. */
export const TREASURY_CSV_HEADER = [
  'Date',
  'Type',
  'Description',
  'Direction',
  'Treasury account',
  'Counterparty',
  'Amount (USD)',
  'Treasury effect (USD)',
  'Status',
] as const;

/** The fields the CSV export needs from a classified, labeled ledger entry. */
export interface TreasuryCsvEntry {
  createdAt: string;
  type: string;
  description: string | null;
  direction: TreasuryLegDirection;
  scopeLabel: string;
  counterpartyLabel: string | null;
  /** Always-positive transaction amount. */
  grossAmountCents: number;
  /** Treasury-signed contribution: `+` in, `-` out, `0` internal. */
  signedAmountCents: number;
  status: string;
}

/** Renders cents as a plain fixed-2 decimal string (no symbol, no grouping). */
function usdCell(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Builds the CSV matrix (header + one row per entry) for a treasury export.
 *
 * Carries TWO amount columns on purpose (audit T1-2). The export previously
 * emitted only the treasury-signed amount, which is `0` for every internal leg
 * BY DESIGN — funding a project is net-zero to the treasury as a whole — so
 * allocations and sweeps exported as zero-value events while the UI showed
 * their real value, and fund/project movement was unauditable off-platform.
 * `Amount (USD)` is therefore the gross figure the UI shows for every row, and
 * `Treasury effect (USD)` is the signed P&L contribution (`0.00` on an internal
 * move, which the `Direction` column explains).
 *
 * @param entries Classified ledger entries, already ordered for display.
 * @returns Header row followed by one string row per entry.
 * @example
 * ```ts
 * const csv = toCsvText(buildTreasuryCsvRows(entries));
 * ```
 */
export function buildTreasuryCsvRows(entries: readonly TreasuryCsvEntry[]): string[][] {
  return [
    [...TREASURY_CSV_HEADER],
    ...entries.map((entry) => [
      new Date(entry.createdAt).toISOString(),
      entry.type,
      entry.description ?? '',
      entry.direction,
      entry.scopeLabel,
      entry.counterpartyLabel ?? '',
      usdCell(entry.grossAmountCents),
      usdCell(entry.signedAmountCents),
      entry.status,
    ]),
  ];
}

/**
 * Serializes a CSV matrix, quoting every cell and doubling embedded quotes.
 *
 * @param rows The matrix from {@link buildTreasuryCsvRows}.
 * @returns Newline-joined CSV text.
 */
export function toCsvText(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

/** Aggregate treasury totals over a set of classified legs. */
export interface TreasuryLegTotals {
  /** Sum of external inflows (money into the treasury). */
  inflowCents: number;
  /** Sum of external outflows (money out of the treasury). */
  outflowCents: number;
  /** `inflowCents - outflowCents` — net change to the treasury. */
  netCents: number;
  /** Count of internal (treasury-to-treasury) movements. */
  internalCount: number;
}

/**
 * Aggregates classified legs into treasury inflow/outflow/net totals. Internal
 * movements are counted but never contribute to inflow/outflow, so moving money
 * from the group into a fund or project never reads as revenue or expense.
 */
export function summarizeTreasuryLegs(legs: readonly ClassifiedTreasuryLeg[]): TreasuryLegTotals {
  let inflowCents = 0;
  let outflowCents = 0;
  let internalCount = 0;

  for (const leg of legs) {
    if (leg.direction === 'in') {
      inflowCents += leg.signedAmountCents;
    } else if (leg.direction === 'out') {
      outflowCents += -leg.signedAmountCents;
    } else {
      internalCount += 1;
    }
  }

  return { inflowCents, outflowCents, netCents: inflowCents - outflowCents, internalCount };
}
