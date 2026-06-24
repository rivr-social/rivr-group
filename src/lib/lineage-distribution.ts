/**
 * Directed referral-lineage distribution resolver (EPIC J6 / J8).
 *
 * Purpose:
 * When a project-bound offering sells, the spec calls for the seller-net to
 * cascade NOT just to the project's explicitly-configured downstream recipients,
 * but up the project's **directed referral lineage graph** — the project owner's
 * parent-group chain plus any opted-in coallied (associated) groups. This is the
 * "if I sell 5 of a product through a project it should respect the directed
 * referral lineage graph paths back up the chain" requirement.
 *
 * This module is the single place that turns the *graph* (agent `parentId`
 * lineage + coalition ledger edges) into concrete
 * {@link ProjectDistributionEntry} rows. It is intentionally separate from
 * `settlement-splits.ts`: that module does the rounding-exact bps math and the
 * project-keep logic; this module only *resolves which recipients and at what
 * bps* the lineage graph implies. `resolveSettlementSplits` composes the two.
 *
 * DEFAULT CASCADE (J6/J8, decision 2026-06-23): the lineage cascade is now ON
 * BY DEFAULT but FULLY OVERRIDABLE. When a project (and its org) has NOT
 * authored an explicit lineage config, net still cascades up the parent lineage
 * by {@link DEFAULT_LINEAGE_CASCADE_BPS} per hop. The default is intentionally
 * CONSERVATIVE (see the constant) so real money never moves on an aggressive
 * inferred split. A project or org can override the default at any time — set
 * `lineage.enabled = false` to opt OUT entirely, or author explicit
 * `levelBps`/`coallied` to replace the per-hop default with chosen values.
 *
 * The default applies ONLY to the ancestor chain (a flat per-hop share); opted-in
 * coallied payout remains strictly explicit (a coallied group never shares on an
 * inferred default — it must be named in config).
 */
import { db } from '@/db';
import { agents, ledger } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getAgentLineage } from '@/db/queries';
import type {
  ProjectDistributionEntry,
  SettlementRole,
} from '@/lib/settlement-splits';

/**
 * Default per-ancestor-hop lineage share, in basis points, applied when a
 * project/org has NOT authored an explicit lineage config.
 *
 * ⚠️ PLACEHOLDER — Cameron to set the real value. This is a deliberately
 * CONSERVATIVE flat 1.00% (100 bps) per hop: the immediate parent org gets 1%,
 * the grandparent 1%, etc., up to {@link DEFAULT_LINEAGE_MAX_HOPS} levels. The
 * project keeps the overwhelming majority of its net by default. Set to a curve
 * (e.g. a per-hop decay) or a different flat value here — every consumer reads
 * this single constant.
 */
export const DEFAULT_LINEAGE_CASCADE_BPS = 100;

/**
 * Maximum number of ancestor hops the DEFAULT cascade reaches. Bounds the
 * implicit default so a deep lineage chain cannot silently consume a large share
 * of project net. Explicit per-level config (`levelBps`) is NOT bounded by this —
 * an org that authors deeper levels gets exactly what it authored.
 *
 * ⚠️ PLACEHOLDER — pairs with {@link DEFAULT_LINEAGE_CASCADE_BPS}; 2 hops at 1%
 * each caps the default cascade at 2% of net.
 */
export const DEFAULT_LINEAGE_MAX_HOPS = 2;

/** Relationship types whose edges are eligible to share in lineage payout. */
export const COALLIED_RELATIONSHIP_TYPES = [
  'coalition',
  'affiliate',
  'partner',
] as const;

export type CoalliedRelationshipType =
  (typeof COALLIED_RELATIONSHIP_TYPES)[number];

/**
 * The lineage-distribution config stored on a project resource's
 * `metadata.lineage`. All bps are server-trusted (written by the project split
 * editor, never client input at settlement time).
 */
export interface LineageDistributionConfig {
  /** Master switch — lineage cascade only runs when this is true. */
  enabled: boolean;
  /**
   * Whether this config was EXPLICITLY authored (a `metadata.lineage` object was
   * present). When false/absent, no explicit config exists and callers may apply
   * the {@link DEFAULT_LINEAGE_CASCADE_BPS} default. This lets us tell an
   * explicit opt-out (`{ enabled: false }`, authored) apart from "nothing
   * configured" (default cascade applies). Optional so ad-hoc configs passed
   * directly to {@link resolveLineageDistribution} need not set it.
   */
  explicit?: boolean;
  /**
   * Per-ancestor-level bps, indexed by distance from the project owner:
   * `levelBps[0]` = the project owner's immediate parent group, `levelBps[1]` =
   * grandparent, etc. A missing/zero entry means that level receives nothing.
   */
  levelBps?: number[];
  /**
   * Explicitly opted-in coallied groups and their bps. Only groups listed here
   * share in payout (spec §7.5: coallied payout is OPT-IN per project).
   */
  coallied?: { agentId: string; bps: number }[];
}

/**
 * Parses and validates `metadata.lineage` off a project resource into a
 * {@link LineageDistributionConfig}. Malformed fields are dropped rather than
 * throwing so a single bad config value cannot strand settlement.
 *
 * A MISSING `metadata.lineage` yields `{ enabled: false, explicit: false }` —
 * "nothing authored" — which lets the default-cascade layer kick in. An authored
 * object yields `explicit: true` and `enabled` reflects its `enabled` flag, so a
 * project can explicitly opt OUT (`{ enabled: false }`) and the default will NOT
 * re-enable it.
 */
export function parseLineageConfig(
  metadata: Record<string, unknown> | null | undefined,
): LineageDistributionConfig {
  const raw = (metadata ?? {})['lineage'];
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, explicit: false };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj['enabled'] === true;

  const levelBps: number[] = [];
  if (Array.isArray(obj['levelBps'])) {
    for (const v of obj['levelBps']) {
      levelBps.push(
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0,
      );
    }
  }

  const coallied: { agentId: string; bps: number }[] = [];
  if (Array.isArray(obj['coallied'])) {
    for (const item of obj['coallied']) {
      if (!item || typeof item !== 'object') continue;
      const agentId = (item as Record<string, unknown>)['agentId'];
      const bps = (item as Record<string, unknown>)['bps'];
      if (typeof agentId !== 'string' || agentId.length === 0) continue;
      if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) continue;
      coallied.push({ agentId, bps: Math.floor(bps) });
    }
  }

  return { enabled, explicit: true, levelBps, coallied };
}

/**
 * Builds the DEFAULT lineage config applied when neither a project nor its org
 * has authored an explicit `metadata.lineage`. Produces a flat
 * {@link DEFAULT_LINEAGE_CASCADE_BPS} per ancestor hop, capped at
 * {@link DEFAULT_LINEAGE_MAX_HOPS} levels, with NO coallied entries (coallied
 * payout is never inferred). Exposed so the project/org split-config UI can
 * PRE-FILL these editable values rather than treating them as a hidden rule.
 *
 * @returns An enabled, default-valued lineage config.
 */
export function defaultLineageConfig(): LineageDistributionConfig {
  if (DEFAULT_LINEAGE_CASCADE_BPS <= 0 || DEFAULT_LINEAGE_MAX_HOPS <= 0) {
    return { enabled: false, explicit: false, levelBps: [], coallied: [] };
  }
  const levelBps = new Array<number>(DEFAULT_LINEAGE_MAX_HOPS).fill(
    DEFAULT_LINEAGE_CASCADE_BPS,
  );
  return { enabled: true, explicit: false, levelBps, coallied: [] };
}

/**
 * Resolves the EFFECTIVE lineage config for a project given the project's own
 * parsed config and (optionally) its owning org's parsed config. Precedence:
 *   1. An explicit project config wins outright (including an explicit opt-out).
 *   2. Otherwise an explicit org config applies (org-level default override).
 *   3. Otherwise the system {@link defaultLineageConfig} cascade applies.
 *
 * This is the single place the "default ON, overridable at org AND project
 * level" decision is encoded.
 *
 * @param projectConfig Parsed `metadata.lineage` from the project resource.
 * @param orgConfig Parsed `metadata.lineage` from the owning org agent, if any.
 * @returns The lineage config settlement should actually use.
 */
export function resolveEffectiveLineageConfig(
  projectConfig: LineageDistributionConfig,
  orgConfig?: LineageDistributionConfig | null,
): LineageDistributionConfig {
  if (projectConfig.explicit) return projectConfig;
  if (orgConfig && orgConfig.explicit) return orgConfig;
  return defaultLineageConfig();
}

/**
 * Returns the ordered ancestor chain of a project owner, EXCLUDING the owner
 * itself, nearest-parent first. Reuses the tested recursive-CTE lineage query.
 *
 * @param ownerAgentId The project's owning group/org agent.
 * @returns Ancestor agent ids, nearest parent first (depth 1, 2, …).
 */
export async function getProjectAncestorChain(
  ownerAgentId: string,
): Promise<string[]> {
  const lineage = await getAgentLineage(ownerAgentId);
  // getAgentLineage returns [self, parent, grandparent, …] depth-ASC; drop self.
  return lineage.filter((id) => id !== ownerAgentId);
}

/**
 * Returns the set of agent ids that hold an eligible coallied relationship edge
 * with the given group, in EITHER direction, restricted to the explicitly
 * opted-in ids. A relationship edge is a ledger row with `object_type='agent'`
 * and `metadata.relationshipType` in {@link COALLIED_RELATIONSHIP_TYPES}.
 *
 * @param groupId The project owner group.
 * @param optedInIds The coallied agent ids the project explicitly configured.
 * @returns The subset of `optedInIds` that have a real, active coallied edge.
 */
export async function getVerifiedCoalliedGroups(
  groupId: string,
  optedInIds: string[],
): Promise<Set<string>> {
  if (optedInIds.length === 0) return new Set();

  const rows = (await db.execute(sql`
    SELECT subject_id, object_id, metadata
    FROM ledger
    WHERE is_active = true
      AND object_type = 'agent'
      AND (subject_id = ${groupId}::uuid OR object_id = ${groupId}::uuid)
      AND metadata->>'relationshipType' IS NOT NULL
  `)) as Array<Record<string, unknown>>;

  const optedIn = new Set(optedInIds);
  const verified = new Set<string>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const relType = meta['relationshipType'];
    if (
      typeof relType !== 'string' ||
      !COALLIED_RELATIONSHIP_TYPES.includes(relType as CoalliedRelationshipType)
    ) {
      continue;
    }
    const subjectId = row.subject_id as string;
    const objectId = (row.object_id as string) ?? '';
    // The counterpart is whichever side is not the group itself.
    const counterpart = subjectId === groupId ? objectId : subjectId;
    if (counterpart && optedIn.has(counterpart)) {
      verified.add(counterpart);
    }
  }
  return verified;
}

/**
 * Resolves the directed lineage-graph distribution entries for a project.
 *
 * Walks the project owner's ancestor chain applying `levelBps` per level, then
 * adds verified opted-in coallied groups. Returns entries in the same shape as
 * `metadata.distribution` so the existing settlement resolver can fold them in
 * alongside any explicit recipients (the caller dedupes + clamps the union).
 *
 * Entries are emitted nearest-ancestor first (highest trust / priority), with
 * coallied groups after the lineage chain.
 *
 * @param ownerAgentId The project's owning group/org agent.
 * @param config Parsed lineage config from the project metadata.
 * @returns Ordered distribution entries implied by the lineage graph.
 */
export async function resolveLineageDistribution(
  ownerAgentId: string,
  config: LineageDistributionConfig,
): Promise<ProjectDistributionEntry[]> {
  if (!config.enabled) return [];

  const entries: ProjectDistributionEntry[] = [];

  const levelBps = config.levelBps ?? [];
  if (levelBps.some((bps) => bps > 0)) {
    const ancestors = await getProjectAncestorChain(ownerAgentId);
    for (let level = 0; level < ancestors.length; level++) {
      const bps = levelBps[level] ?? 0;
      if (bps <= 0) continue;
      entries.push({
        recipientId: ancestors[level],
        bps,
        role: 'parent_org' as SettlementRole,
      });
    }
  }

  const coallied = config.coallied ?? [];
  if (coallied.length > 0) {
    const verified = await getVerifiedCoalliedGroups(
      ownerAgentId,
      coallied.map((c) => c.agentId),
    );
    for (const entry of coallied) {
      if (!verified.has(entry.agentId)) continue;
      entries.push({
        recipientId: entry.agentId,
        bps: entry.bps,
        role: 'ally' as SettlementRole,
      });
    }
  }

  return entries;
}

/**
 * Agent types that represent a group/org and are therefore eligible to be a
 * lineage settlement recipient. Mirrors the group-like members of the
 * `agent_type` enum (there is no literal `'group'` value).
 */
export const GROUP_LIKE_AGENT_TYPES = [
  'organization',
  'org',
  'ring',
  'family',
  'guild',
  'community',
] as const;

/**
 * Confirms an agent is an organization/group-type agent eligible to be a
 * settlement recipient. Used defensively before crediting a lineage ancestor.
 */
export async function isGroupAgent(agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ type: agents.type })
    .from(agents)
    .where(and(eq(agents.id, agentId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  return (
    row?.type !== undefined &&
    (GROUP_LIKE_AGENT_TYPES as readonly string[]).includes(row.type)
  );
}
