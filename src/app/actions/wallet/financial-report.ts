'use server';

/**
 * Group financial report (backlog B15) — a single date-ranged report that
 * reflects the whole treasury cascade:
 * - a PROFIT & LOSS from the consolidated treasury ledger (external inflows vs.
 *   outflows across the group + funds + projects + subgroups, internal moves
 *   excluded), broken down by transaction type; and
 * - a BUDGET rollup (per-project → per-subgroup → per-group committed/spent vs.
 *   authored targets).
 *
 * Composes the existing manage-gated actions (`getGroupTreasuryLedgerAction`,
 * `getGroupBudgetRollupAction`) so authority + money math stay single-sourced.
 */

import {
  getGroupTreasuryLedgerAction,
  type TreasuryTypeTotal,
} from './treasury-ledger';
import { getGroupBudgetRollupAction } from './project-budget';
import type { BudgetRollupNode } from '@/lib/budget-rollup';

export interface GroupFinancialReport {
  periodStartIso: string | null;
  periodEndIso: string | null;
  treasury: {
    inflowCents: number;
    outflowCents: number;
    netCents: number;
    byType: TreasuryTypeTotal[];
  };
  /** Budget rollup for the SAME window as the P&L above. */
  budget: BudgetRollupNode | null;
  /**
   * True when the budget half carries figures that cannot be period-bounded —
   * the authored TARGET and the COMMITTED position are standing amounts, not
   * period flows (audit T1-5: a "Last month" report showed a $0.00 P&L beside
   * July's $33.50 spent, with nothing saying the two halves covered different
   * spans). Spend figures ARE bounded; consumers must label the rest.
   */
  budgetTargetIsLifetime: boolean;
}

/**
 * Builds a group's financial report over an optional date range. Requires the
 * viewer to manage the group (inherited from the composed actions).
 *
 * @param {string} groupId - The group agent UUID.
 * @param {{ sinceIso?: string; untilIso?: string }} [options] - Inclusive date bounds.
 * @returns {Promise<{ success: boolean; report?: GroupFinancialReport; error?: string }>} The report or an error.
 * @example
 * ```ts
 * const { report } = await getGroupFinancialReportAction(groupId, { sinceIso, untilIso });
 * ```
 */
export async function getGroupFinancialReportAction(
  groupId: string,
  options?: { sinceIso?: string; untilIso?: string },
): Promise<{ success: boolean; report?: GroupFinancialReport; error?: string }> {
  const [ledgerResult, budgetResult] = await Promise.all([
    getGroupTreasuryLedgerAction(groupId, {
      limit: 1,
      sinceIso: options?.sinceIso,
      untilIso: options?.untilIso,
    }),
    // Same window as the P&L — `untilIso` used to be dropped here entirely.
    getGroupBudgetRollupAction(groupId, {
      sinceIso: options?.sinceIso,
      untilIso: options?.untilIso,
    }),
  ]);

  if (!ledgerResult.success || !ledgerResult.ledger) {
    return { success: false, error: ledgerResult.error ?? 'Unable to build the report.' };
  }
  if (!ledgerResult.ledger.canManageTree) {
    return { success: false, error: 'Financial reports are available to treasury managers.' };
  }

  const { totals, byType } = ledgerResult.ledger;

  return {
    success: true,
    report: {
      periodStartIso: options?.sinceIso ?? null,
      periodEndIso: options?.untilIso ?? null,
      treasury: {
        inflowCents: totals.inflowCents,
        outflowCents: totals.outflowCents,
        netCents: totals.netCents,
        byType,
      },
      // Budget rollup only when the viewer can see it (manager) — absent otherwise.
      budget: budgetResult.success ? budgetResult.rollup ?? null : null,
      budgetTargetIsLifetime: true,
    },
  };
}
