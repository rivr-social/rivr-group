/**
 * Peer point allocation for multi-assignee jobs (2026-07-10).
 *
 * A job-level point pool (task-less jobs) is split by MUTUAL assessment:
 * each assignee sets slider weights over the OTHER assignees; every rater's
 * distribution normalizes to 1 and the final share is the average of the
 * raters' distributions, converted to integer points by largest-remainder.
 * With no usable inputs the pool splits equally — peer allocation refines
 * the default, it never blocks completion.
 *
 * Pure module (no db) so the math is unit-testable; the metadata shape it
 * consumes is `job.metadata.pointShareInputs: { [raterId]: { [assigneeId]:
 * weight } }` written by `setJobPointShareInputAction`.
 */

/** Per-rater slider weights over other assignees. */
export type PointShareInputs = Record<string, Record<string, number>>;

/**
 * Computes each assignee's fractional share (summing to 1) from the raters'
 * inputs. Self-ratings and weights for non-assignees are discarded; a rater
 * whose remaining weights are all zero/invalid contributes nothing.
 * Assignees never rated by anyone share the residual equally only when NO
 * valid inputs exist at all (full equal-split fallback).
 */
export function computePeerShareFractions(
  assignees: string[],
  inputs: PointShareInputs | null | undefined,
): Map<string, number> {
  const shares = new Map<string, number>();
  if (assignees.length === 0) return shares;

  const assigneeSet = new Set(assignees);
  const perRaterDistributions: Array<Map<string, number>> = [];

  for (const [raterId, rawWeights] of Object.entries(inputs ?? {})) {
    if (!assigneeSet.has(raterId) || !rawWeights || typeof rawWeights !== "object") continue;
    const cleaned = new Map<string, number>();
    let total = 0;
    for (const [assigneeId, weight] of Object.entries(rawWeights)) {
      if (assigneeId === raterId) continue; // no self-rating
      if (!assigneeSet.has(assigneeId)) continue;
      const w = Number(weight);
      if (!Number.isFinite(w) || w <= 0) continue;
      cleaned.set(assigneeId, w);
      total += w;
    }
    if (total <= 0) continue;
    const normalized = new Map<string, number>();
    for (const [assigneeId, w] of cleaned) normalized.set(assigneeId, w / total);
    perRaterDistributions.push(normalized);
  }

  if (perRaterDistributions.length === 0) {
    // No usable peer input — equal split.
    for (const id of assignees) shares.set(id, 1 / assignees.length);
    return shares;
  }

  for (const id of assignees) shares.set(id, 0);
  for (const distribution of perRaterDistributions) {
    for (const [assigneeId, fraction] of distribution) {
      shares.set(assigneeId, (shares.get(assigneeId) ?? 0) + fraction / perRaterDistributions.length);
    }
  }
  return shares;
}

/**
 * Converts the fractional shares of a point pool into integer points via
 * largest-remainder so the total always sums EXACTLY to `totalPoints`.
 * Deterministic: remainder ties break by assignee id order.
 */
export function allocatePointsByShares(
  totalPoints: number,
  assignees: string[],
  inputs: PointShareInputs | null | undefined,
): Map<string, number> {
  const result = new Map<string, number>();
  if (assignees.length === 0 || !Number.isFinite(totalPoints) || totalPoints <= 0) {
    for (const id of assignees) result.set(id, 0);
    return result;
  }

  const fractions = computePeerShareFractions(assignees, inputs);
  const sorted = [...assignees].sort();
  const raw = sorted.map((id) => ({
    id,
    exact: (fractions.get(id) ?? 0) * totalPoints,
  }));

  let allocated = 0;
  const withFloor = raw.map((entry) => {
    const floor = Math.floor(entry.exact);
    allocated += floor;
    return { ...entry, floor, remainder: entry.exact - floor };
  });

  let leftover = Math.round(totalPoints - allocated);
  // Largest remainder first; ties break by id order (already sorted).
  const byRemainder = [...withFloor].sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1));
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    entry.floor += 1;
    leftover -= 1;
  }

  for (const entry of withFloor) result.set(entry.id, entry.floor);
  return result;
}
