/**
 * Org net %-allocation tree (EPIC J7).
 *
 * Purpose:
 * Under the Stake surface a group/org can author an editable TREE that allocates
 * a percentage of the org's NET (post-expense Layer-2 distribution) to either a
 * membership CLASS (e.g. all `host`-tier members) or a named INDIVIDUAL. EPIC J7
 * is the configuration + resolution layer: this module parses & validates the
 * authored tree, and — given the concrete membership of each class — RESOLVES it
 * into per-individual bps shares that sum to exactly the distributed total.
 *
 * It deliberately stops at producing the per-recipient bps split. The actual
 * money movement (a Layer-2 distribution RUN that debits the treasury and
 * credits wallets) reuses the shared `allocateByBps` exact-sum rounding from
 * `settlement-splits.ts` and is sequenced separately (see the gap-analysis open
 * questions) — this module never moves money.
 *
 * FINANCIAL SAFETY: the authored tree must not over-allocate; the sum of all
 * rule bps is validated against the full pie. Class rules with no resolved
 * members contribute nothing (their share is NOT silently redistributed — it
 * stays with the org), so an empty class can never inflate another recipient.
 */
import { BPS_DIVISOR } from '@/lib/wallet-constants';

/** The full pie in basis points (100%). */
export const NET_ALLOCATION_FULL_PIE_BPS = BPS_DIVISOR;

/** Whether a rule targets a membership class or a specific individual. */
export type NetAllocationTargetType = 'class' | 'individual';

/** A single authored allocation rule. */
export interface NetAllocationRule {
  /** Target kind. */
  targetType: NetAllocationTargetType;
  /**
   * For `class`: the membership tier/class key (e.g. `'host'`). For
   * `individual`: the recipient agent id.
   */
  targetId: string;
  /** Share of org net in basis points (positive integer). */
  bps: number;
  /** Optional label for UI display. */
  label?: string;
}

/** The parsed, validated allocation tree. */
export interface NetAllocationTree {
  rules: NetAllocationRule[];
}

/** A resolved per-individual share produced from the tree. */
export interface ResolvedNetAllocation {
  recipientId: string;
  bps: number;
  /** Which authored rule produced this share. */
  sourceTargetType: NetAllocationTargetType;
  sourceTargetId: string;
}

/** Result of validating an allocation tree. */
export type NetAllocationValidation =
  | { valid: true; totalBps: number }
  | { valid: false; error: string; totalBps: number };

/**
 * Parses arbitrary stored metadata (`metadata.netAllocation`) into a
 * {@link NetAllocationTree}. Malformed rules are dropped rather than throwing so
 * a single bad row cannot strand the editor; use {@link validateNetAllocationTree}
 * to reject over-allocation before persisting.
 */
export function parseNetAllocationTree(
  metadata: Record<string, unknown> | null | undefined,
): NetAllocationTree {
  const raw = (metadata ?? {})['netAllocation'];
  if (!raw || typeof raw !== 'object') return { rules: [] };
  const rulesRaw = (raw as Record<string, unknown>)['rules'];
  if (!Array.isArray(rulesRaw)) return { rules: [] };

  const rules: NetAllocationRule[] = [];
  for (const item of rulesRaw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const targetType = obj['targetType'];
    const targetId = obj['targetId'];
    const bps = obj['bps'];
    const label = obj['label'];
    if (targetType !== 'class' && targetType !== 'individual') continue;
    if (typeof targetId !== 'string' || targetId.length === 0) continue;
    if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) continue;
    rules.push({
      targetType,
      targetId,
      bps: Math.floor(bps),
      label: typeof label === 'string' ? label : undefined,
    });
  }
  return { rules };
}

/**
 * Validates an authored allocation tree: every rule must be well-formed and the
 * SUM of all rule bps must not exceed the full pie. The org implicitly keeps any
 * undistributed remainder, so a sum below the pie is valid.
 *
 * @param tree The tree to validate.
 * @returns A validation result; `totalBps` is always the summed bps.
 */
export function validateNetAllocationTree(
  tree: NetAllocationTree,
): NetAllocationValidation {
  let total = 0;
  for (const rule of tree.rules) {
    if (rule.bps <= 0 || !Number.isInteger(rule.bps)) {
      return {
        valid: false,
        error: `Rule for "${rule.targetId}" has invalid bps ${rule.bps}.`,
        totalBps: total,
      };
    }
    total += rule.bps;
  }
  if (total > NET_ALLOCATION_FULL_PIE_BPS) {
    return {
      valid: false,
      error: `Allocation total ${total} bps exceeds the full pie (${NET_ALLOCATION_FULL_PIE_BPS} bps).`,
      totalBps: total,
    };
  }
  return { valid: true, totalBps: total };
}

/**
 * Resolves an allocation tree into concrete per-individual bps shares.
 *
 * - An `individual` rule contributes its full bps to that recipient.
 * - A `class` rule splits its bps across the resolved members of the class.
 *   When `memberWeights` is supplied and the class's members hold a positive
 *   total weight, the split is PROPORTIONAL TO WEIGHT (stake distribution by
 *   points earned in the org and its subgroups — Cameron, 2026-07-02);
 *   members with zero weight receive nothing. When no weights are supplied,
 *   or no member of the class holds any weight, the split falls back to
 *   EQUAL. Both paths use exact-sum largest-remainder rounding (so the
 *   class's bps is neither lost nor inflated). A class with NO members
 *   contributes nothing — its share stays with the org rather than leaking
 *   to other recipients.
 *
 * Shares for the same recipient arising from multiple rules are summed.
 *
 * @param tree The validated allocation tree.
 * @param classMembers Map of class key → member agent ids.
 * @param memberWeights Optional per-member stake weight (points earned across
 *   the org subtree). Missing members count as weight 0.
 * @returns Resolved per-individual shares (deduped/summed), in stable order.
 */
export function resolveNetAllocation(
  tree: NetAllocationTree,
  classMembers: Map<string, string[]>,
  memberWeights?: Map<string, number>,
): ResolvedNetAllocation[] {
  const order: string[] = [];
  const byRecipient = new Map<string, ResolvedNetAllocation>();

  const add = (
    recipientId: string,
    bps: number,
    sourceTargetType: NetAllocationTargetType,
    sourceTargetId: string,
  ) => {
    if (bps <= 0) return;
    const existing = byRecipient.get(recipientId);
    if (existing) {
      existing.bps += bps;
      return;
    }
    order.push(recipientId);
    byRecipient.set(recipientId, {
      recipientId,
      bps,
      sourceTargetType,
      sourceTargetId,
    });
  };

  for (const rule of tree.rules) {
    if (rule.targetType === 'individual') {
      add(rule.targetId, rule.bps, 'individual', rule.targetId);
      continue;
    }
    // class
    const members = classMembers.get(rule.targetId) ?? [];
    if (members.length === 0) continue; // empty class → stays with the org

    const weights = members.map((id) => {
      const w = memberWeights?.get(id) ?? 0;
      return Number.isFinite(w) && w > 0 ? w : 0;
    });
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    const shares =
      totalWeight > 0
        ? splitBpsByWeight(rule.bps, weights)
        : splitBpsEqually(rule.bps, members.length);
    for (const share of shares) {
      const recipientId = members[share.index];
      add(recipientId, share.bps, 'class', rule.targetId);
    }
  }

  return order.map((id) => byRecipient.get(id)!);
}

/**
 * Splits a bps amount equally across `count` recipients so the parts sum
 * EXACTLY to `totalBps` (largest-remainder: the first `remainder` recipients get
 * one extra bps). Returns index→bps so callers can map back to member ids.
 */
function splitBpsEqually(
  totalBps: number,
  count: number,
): Array<{ index: number; bps: number }> {
  if (count <= 0) return [];
  const base = Math.floor(totalBps / count);
  const remainder = totalBps - base * count;
  const parts: Array<{ index: number; bps: number }> = [];
  for (let i = 0; i < count; i++) {
    parts.push({ index: i, bps: base + (i < remainder ? 1 : 0) });
  }
  return parts;
}

/**
 * Splits a bps amount across recipients PROPORTIONALLY TO WEIGHT so the parts
 * sum EXACTLY to `totalBps` (largest-remainder over the fractional parts;
 * ties broken by index for determinism). Zero-weight recipients get 0 bps and
 * never receive remainder bps. Callers must ensure the total weight is > 0.
 */
function splitBpsByWeight(
  totalBps: number,
  weights: number[],
): Array<{ index: number; bps: number }> {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return [];

  const exact = weights.map((w) => (totalBps * w) / totalWeight);
  const parts = exact.map((v, index) => ({
    index,
    bps: Math.floor(v),
    frac: v - Math.floor(v),
  }));

  let remainder = totalBps - parts.reduce((sum, p) => sum + p.bps, 0);
  // Distribute leftover bps to the largest fractional parts, but only to
  // recipients holding real weight — a zero-weight member must stay at 0.
  const byFrac = parts
    .filter((p) => weights[p.index] > 0)
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const p of byFrac) {
    if (remainder <= 0) break;
    p.bps += 1;
    remainder -= 1;
  }

  return parts.map(({ index, bps }) => ({ index, bps }));
}
