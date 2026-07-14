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
