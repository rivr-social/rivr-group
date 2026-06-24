/**
 * Server-side resolver for how a sale's seller-net amount is distributed when
 * the sold offering is bound to a project.
 *
 * Purpose:
 * Given the seller, the listing metadata (which may carry a `projectId`), and
 * the net amount owed to the supply side of a sale, resolve the ordered set of
 * settlement targets:
 *   - the project treasury wallet (the project's retained share), and
 *   - any configured downstream recipients (parent org, coallied groups) that
 *     the project's distribution config cascades a share to.
 *
 * This is the single authoritative resolver for project-scoped settlement. It
 * is intentionally config-driven: the cascade is read from the project
 * resource's `metadata.distribution` (written by the project/org split-config
 * UI), never inferred from client input. The bps of each downstream recipient
 * is server-trusted; only the offering's `projectId` may originate from the
 * listing record (itself created server-side).
 *
 * Reuse:
 * The same resolver backs the referral and membership settlement threads — they
 * all compute "how is this net amount split across wallets" through
 * `allocateByBps` so the math (exact-sum largest-remainder rounding) is shared
 * and never drifts between surfaces.
 */
import { db } from '@/db';
import { agents, resources } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { BPS_DIVISOR } from '@/lib/wallet-constants';
import {
  parseLineageConfig,
  resolveEffectiveLineageConfig,
  resolveLineageDistribution,
} from '@/lib/lineage-distribution';

/** The full pie in basis points. A project may distribute at most all of it. */
export const FULL_PIE_BPS = BPS_DIVISOR;

/** Where a settlement share lands. */
export type SettlementWalletKind = 'agent' | 'project';

/** Semantic role of a settlement recipient, for ledger/UI labeling. */
export type SettlementRole =
  | 'seller'
  | 'project'
  | 'parent_org'
  | 'ally'
  | 'distribution';

/** A single settlement target expressed as a share (bps) of the seller-net. */
export interface SettlementSplit {
  /** `project` → credit the project treasury wallet; `agent` → the recipient's settlement wallet. */
  walletKind: SettlementWalletKind;
  /** Agent that owns the receiving wallet (project owner for project kind). */
  ownerAgentId: string;
  /** The project resource id, present only when `walletKind === 'project'`. */
  projectResourceId?: string;
  /** Recipient role for labeling. */
  role: SettlementRole;
  /** Share of the seller-net, in basis points. */
  bps: number;
}

/** A settlement split with its resolved integer-cents amount. */
export interface SettlementAllocation extends SettlementSplit {
  amountCents: number;
}

/** A single downstream distribution entry as stored on a project resource. */
export interface ProjectDistributionEntry {
  recipientId: string;
  bps: number;
  role?: SettlementRole;
}

export interface ResolveSettlementSplitsParams {
  /** Seller agent id — receives 100% when the offering is not project-bound. */
  sellerId: string;
  /** Listing/offering metadata; may carry a `projectId` string. */
  listingMeta: Record<string, unknown>;
  /** Buyer agent id, when known — excluded from being a downstream recipient. */
  buyerId?: string | null;
}

/**
 * Parses and validates the `metadata.distribution` array off a project resource.
 * Each entry must carry a non-empty `recipientId` and a positive integer `bps`.
 * Malformed entries are dropped rather than throwing so a single bad config
 * row cannot strand settlement.
 */
export function parseProjectDistribution(
  metadata: Record<string, unknown> | null | undefined,
): ProjectDistributionEntry[] {
  const raw = (metadata ?? {})['distribution'];
  if (!Array.isArray(raw)) return [];

  const entries: ProjectDistributionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const recipientId = (item as Record<string, unknown>)['recipientId'];
    const bpsRaw = (item as Record<string, unknown>)['bps'];
    const roleRaw = (item as Record<string, unknown>)['role'];
    if (typeof recipientId !== 'string' || recipientId.length === 0) continue;
    if (typeof bpsRaw !== 'number' || !Number.isFinite(bpsRaw) || bpsRaw <= 0) {
      continue;
    }
    const role: SettlementRole | undefined =
      roleRaw === 'parent_org' || roleRaw === 'ally' || roleRaw === 'distribution'
        ? roleRaw
        : undefined;
    entries.push({ recipientId, bps: Math.floor(bpsRaw), role });
  }
  return entries;
}

/**
 * Clamps the SUM of downstream distribution bps to a budget by trimming from
 * the end of the list (lowest priority) upward, so earlier (higher-trust)
 * recipients keep their full bps. Entries whose remaining headroom is zero are
 * dropped. Order is preserved.
 */
export function clampDistributionBps(
  entries: ProjectDistributionEntry[],
  budgetBps: number,
): ProjectDistributionEntry[] {
  const total = entries.reduce((sum, e) => sum + e.bps, 0);
  if (total <= budgetBps) return entries;

  let budget = budgetBps;
  const kept: ProjectDistributionEntry[] = [];
  for (const entry of entries) {
    if (budget <= 0) break;
    const allowed = Math.min(entry.bps, budget);
    if (allowed > 0) {
      kept.push({ ...entry, bps: allowed });
      budget -= allowed;
    }
  }
  return kept;
}

/**
 * Splits `totalCents` across the given bps-weighted splits so the resulting
 * integer-cents amounts SUM EXACTLY to `totalCents` (no rounding leakage).
 *
 * Uses the largest-remainder method: floor each share, then hand the leftover
 * cents to the splits with the largest fractional remainders (ties broken by
 * input order, which keeps the project's own keep stable). Splits whose bps is
 * zero are still returned with `amountCents: 0` for a complete audit trail; a
 * caller may filter them out before writing wallet rows.
 *
 * @throws {Error} When the bps total is not exactly `FULL_PIE_BPS`, since that
 *   indicates an unbalanced split set that would lose or invent money.
 */
export function allocateByBps(
  totalCents: number,
  splits: SettlementSplit[],
): SettlementAllocation[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('totalCents must be a non-negative integer');
  }
  const totalBps = splits.reduce((sum, s) => sum + s.bps, 0);
  if (totalBps !== FULL_PIE_BPS) {
    throw new Error(
      `settlement splits must sum to ${FULL_PIE_BPS} bps, got ${totalBps}`,
    );
  }

  const exact = splits.map((split) => {
    const scaled = totalCents * split.bps;
    const floorCents = Math.floor(scaled / FULL_PIE_BPS);
    const remainder = scaled - floorCents * FULL_PIE_BPS;
    return { split, floorCents, remainder };
  });

  const distributed = exact.reduce((sum, e) => sum + e.floorCents, 0);
  let leftover = totalCents - distributed;

  // Hand leftover cents to the largest remainders first; stable by index.
  const order = exact
    .map((e, index) => ({ index, remainder: e.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const bonus = new Array<number>(exact.length).fill(0);
  for (const { index } of order) {
    if (leftover <= 0) break;
    bonus[index] = 1;
    leftover -= 1;
  }

  return exact.map((e, index) => ({
    ...e.split,
    amountCents: e.floorCents + bonus[index],
  }));
}

/**
 * Resolves the ordered settlement splits for a sale.
 *
 * - No project binding → a single split crediting the seller 100%.
 * - Project binding → the project keeps the remainder after its configured
 *   downstream distribution (parent org / allies), each clamped so the total
 *   distributed never exceeds the full pie. Self-referential (recipient ===
 *   project owner) and buyer/seller recipients are dropped from the downstream
 *   set; that headroom returns to the project's own keep.
 *
 * The returned splits always sum to exactly `FULL_PIE_BPS`, so the result can
 * be passed straight to {@link allocateByBps}.
 */
export async function resolveSettlementSplits(
  params: ResolveSettlementSplitsParams,
): Promise<SettlementSplit[]> {
  const projectId = params.listingMeta['projectId'];
  const sellerSplit: SettlementSplit = {
    walletKind: 'agent',
    ownerAgentId: params.sellerId,
    role: 'seller',
    bps: FULL_PIE_BPS,
  };

  if (typeof projectId !== 'string' || projectId.length === 0) {
    return [sellerSplit];
  }

  const [project] = await db
    .select({
      id: resources.id,
      type: resources.type,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(eq(resources.id, projectId))
    .limit(1);

  // A missing, non-project, or deleted target is not a valid treasury sink;
  // fall back to crediting the seller so the sale still settles.
  if (!project || project.type !== 'project' || project.deletedAt) {
    return [sellerSplit];
  }

  const projectOwnerId = project.ownerId;
  const excluded = new Set<string>(
    [projectOwnerId, params.sellerId, params.buyerId ?? ''].filter(
      (id) => id.length > 0,
    ),
  );

  // Downstream recipients are the UNION of (1) the explicit per-recipient
  // distribution config and (2) the directed referral-lineage graph (parent
  // chain + opted-in coallied groups) when the project enables lineage mode.
  // Explicit entries come first so they win on dedupe (a recipient configured
  // both ways keeps its explicit bps). Self/buyer/seller are dropped from both.
  const projectMeta = project.metadata as Record<string, unknown>;
  const explicitEntries = parseProjectDistribution(projectMeta);

  // Lineage cascade is ON by default but fully overridable (J6/J8). Precedence:
  // explicit project config → explicit org config → system default cascade.
  // We only need the org's config when the project did NOT author its own.
  const projectLineage = parseLineageConfig(projectMeta);
  let orgLineage = null;
  if (!projectLineage.explicit) {
    const [orgAgent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, projectOwnerId), sql`${agents.deletedAt} IS NULL`))
      .limit(1);
    orgLineage = parseLineageConfig(
      (orgAgent?.metadata ?? null) as Record<string, unknown> | null,
    );
  }
  const lineageConfig = resolveEffectiveLineageConfig(projectLineage, orgLineage);

  let lineageEntries: ProjectDistributionEntry[] = [];
  if (lineageConfig.enabled) {
    lineageEntries = await resolveLineageDistribution(
      projectOwnerId,
      lineageConfig,
    );
  }

  // Deduped, self/buyer/seller dropped.
  const seen = new Set<string>();
  const downstream: ProjectDistributionEntry[] = [];
  for (const entry of [...explicitEntries, ...lineageEntries]) {
    if (excluded.has(entry.recipientId)) continue;
    if (seen.has(entry.recipientId)) continue;
    seen.add(entry.recipientId);
    downstream.push(entry);
  }

  // The project must always retain at least nothing-negative; cap the total
  // distributed at the full pie minus one bps so the project keeps a share only
  // when config leaves headroom. We allow distributing the entire pie (keep 0).
  const clamped = clampDistributionBps(downstream, FULL_PIE_BPS);
  const distributedBps = clamped.reduce((sum, e) => sum + e.bps, 0);
  const keepBps = FULL_PIE_BPS - distributedBps;

  const splits: SettlementSplit[] = [];

  // Project keep first (highest priority / stable for leftover-cent rounding).
  if (keepBps > 0) {
    splits.push({
      walletKind: 'project',
      ownerAgentId: projectOwnerId,
      projectResourceId: project.id,
      role: 'project',
      bps: keepBps,
    });
  }

  for (const entry of clamped) {
    splits.push({
      walletKind: 'agent',
      ownerAgentId: entry.recipientId,
      role: entry.role ?? 'distribution',
      bps: entry.bps,
    });
  }

  // Edge case: config distributed the entire pie AND every recipient was
  // excluded (e.g. all self-referential) → nothing left; credit the project.
  if (splits.length === 0) {
    splits.push({
      walletKind: 'project',
      ownerAgentId: projectOwnerId,
      projectResourceId: project.id,
      role: 'project',
      bps: FULL_PIE_BPS,
    });
  }

  return splits;
}
