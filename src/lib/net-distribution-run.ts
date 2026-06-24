/**
 * Layer-2 project-net distribution RUN planner (EPIC J7).
 *
 * Purpose:
 * The org net %-allocation tree (`net-allocation.ts`) resolves into per-individual
 * bps SHARES of the org net. This module is the planning layer that turns those
 * resolved bps shares plus a concrete net amount (the cents to distribute) into
 * EXACT integer-cent credit amounts per recipient — the input a distribution RUN
 * feeds into the existing settlement crediting path.
 *
 * It deliberately stops at producing the per-recipient cents plan. The actual
 * money movement (debit the project treasury, credit recipient wallets) lives in
 * the gated `runProjectNetDistributionAction` server action, which reuses the
 * shared crediting helpers (`creditWalletCapital` etc.) rather than duplicating
 * them. This module NEVER moves money and has no DB dependency, so it is fully
 * unit-testable.
 *
 * Exactness:
 * Recipient cents are computed with the same largest-remainder, exact-sum
 * `allocateByBps` used by `settlement-splits.ts`. Because the allocation tree may
 * distribute LESS than the full pie (the org keeps the undistributed remainder),
 * the planner adds an explicit "org keep" split for the remainder so the split
 * set sums to exactly the full pie. The recipient amounts therefore can never
 * over- or under-credit: distributedCents + orgKeepCents === netCents exactly.
 */
import { allocateByBps, FULL_PIE_BPS, type SettlementSplit } from '@/lib/settlement-splits';
import { NET_ALLOCATION_FULL_PIE_BPS, type ResolvedNetAllocation } from '@/lib/net-allocation';

/** Role tag used for the org's retained remainder split in a distribution run. */
export const ORG_KEEP_ROLE = 'distribution' as const;

/** A single planned per-recipient credit produced by the distribution planner. */
export interface PlannedDistributionCredit {
  /** Recipient agent id whose settlement wallet receives the credit. */
  recipientId: string;
  /** Credit amount in integer cents (>= 0). */
  amountCents: number;
  /** Share of the net in basis points (as resolved from the allocation tree). */
  bps: number;
}

/** The complete, exactness-checked plan for one distribution run. */
export interface DistributionRunPlan {
  /** The net amount, in cents, that the run distributes from. */
  netCents: number;
  /** Total bps the allocation tree distributes to recipients (<= full pie). */
  distributedBps: number;
  /** Per-recipient credit plan (recipients with 0 cents are omitted). */
  credits: PlannedDistributionCredit[];
  /** Sum of all recipient credits in cents. */
  distributedCents: number;
  /** Cents retained by the org (full pie remainder + rounding); stays in the wallet. */
  orgKeepCents: number;
}

/**
 * Plans a Layer-2 distribution run: maps resolved bps shares onto exact cents.
 *
 * @param netCents The net amount (cents) to distribute. Must be a non-negative
 *   integer. A zero net yields an empty plan (nothing to distribute).
 * @param resolved The per-individual bps shares from `resolveNetAllocation`.
 * @returns An exactness-checked plan whose recipient cents + org-keep cents sum
 *   to exactly `netCents`.
 * @throws {Error} When `netCents` is not a non-negative integer, or when the
 *   resolved shares over-allocate the full pie (a corrupt/invalid tree).
 */
export function planProjectNetDistribution(
  netCents: number,
  resolved: ResolvedNetAllocation[],
): DistributionRunPlan {
  if (!Number.isInteger(netCents) || netCents < 0) {
    throw new Error(`netCents must be a non-negative integer, got ${netCents}`);
  }

  const distributedBps = resolved.reduce((sum, r) => sum + r.bps, 0);
  if (distributedBps > NET_ALLOCATION_FULL_PIE_BPS) {
    throw new Error(
      `resolved allocation over-allocates: ${distributedBps} bps exceeds the full pie (${NET_ALLOCATION_FULL_PIE_BPS} bps)`,
    );
  }

  if (netCents === 0 || distributedBps === 0) {
    return {
      netCents,
      distributedBps,
      credits: [],
      distributedCents: 0,
      orgKeepCents: netCents,
    };
  }

  // Build a full-pie split set: each recipient at their resolved bps, plus an
  // explicit org-keep split absorbing the undistributed remainder so the set
  // sums to exactly FULL_PIE_BPS (allocateByBps's exact-sum invariant).
  const orgKeepBps = FULL_PIE_BPS - distributedBps;
  const splits: SettlementSplit[] = resolved.map((r) => ({
    walletKind: 'agent',
    ownerAgentId: r.recipientId,
    role: ORG_KEEP_ROLE,
    bps: r.bps,
  }));
  // The org-keep split is last so leftover cents land on recipients first only
  // when their remainder is larger; it carries a sentinel owner id.
  splits.push({
    walletKind: 'agent',
    ownerAgentId: '__org_keep__',
    role: ORG_KEEP_ROLE,
    bps: orgKeepBps,
  });

  const allocations = allocateByBps(netCents, splits);

  const credits: PlannedDistributionCredit[] = [];
  let distributedCents = 0;
  let orgKeepCents = 0;

  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const isOrgKeep = i === allocations.length - 1;
    if (isOrgKeep) {
      orgKeepCents = alloc.amountCents;
      continue;
    }
    if (alloc.amountCents <= 0) continue;
    distributedCents += alloc.amountCents;
    credits.push({
      recipientId: alloc.ownerAgentId,
      amountCents: alloc.amountCents,
      bps: alloc.bps,
    });
  }

  // Exactness guard: nothing is lost or invented.
  if (distributedCents + orgKeepCents !== netCents) {
    throw new Error(
      `distribution plan does not balance: distributed ${distributedCents} + orgKeep ${orgKeepCents} !== net ${netCents}`,
    );
  }

  return {
    netCents,
    distributedBps,
    credits,
    distributedCents,
    orgKeepCents,
  };
}
