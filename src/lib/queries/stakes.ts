/**
 * Stake query module for group membership contribution data.
 *
 * Purpose:
 * - Derives member stakes from TASK POINTS earned across the org and its
 *   subgroup tree (Cameron, 2026-07-02: "stake distribution should be based
 *   on how many points you've earned out of the total in the group and
 *   subgroups").
 * - Aggregates ledger entries for the supporting contribution metrics shown
 *   on the Stake tab.
 *
 * Key exports:
 * - `getGroupSubtreeIds`: Resolves the org + all descendant subgroup agent ids.
 * - `getSubtreeTaskPointsByMember`: Points earned per member across the subtree.
 * - `getMemberStakesForGroup`: Returns member stake data with contribution metrics.
 * - `calculateTotalStakes`: Sums profit share percentages for a set of stakes.
 *
 * Points rail: completing a task writes an `earn` ledger edge with
 * `metadata.interactionType = 'task-points-earned'` and `metadata.points`
 * (see `toggleTaskCompletion`). Stake share = member points / total points.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for Drizzle database access.
 * - `drizzle-orm` SQL templating for aggregation queries.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import type { MemberStake } from "@/lib/types";

/** Ledger metadata marker written at attestation (`@/lib/work-completion`). */
export const TASK_POINTS_INTERACTION = "task-points-earned";

/** Coerces a raw-query timestamp (Date | string | null) to an ISO string. */
function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/**
 * Resolves a group's agent-id subtree: the group itself plus every descendant
 * subgroup (recursive `agents.parent_id` walk, soft-deleted agents excluded).
 *
 * @param groupId Root group/org agent UUID.
 * @returns Array of agent ids (root first, then descendants).
 */
export async function getGroupSubtreeIds(groupId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id FROM agents a
      JOIN grp_tree t ON a.parent_id = t.id
      WHERE a.deleted_at IS NULL
    )
    SELECT id FROM grp_tree
  `)) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.id));
}

/**
 * Sums task points earned per member across a group's subtree.
 *
 * A member "earns points in the org" when they hold an active
 * `earn`/`task-points-earned` ledger edge whose task resource is owned by the
 * org or any of its descendant subgroups.
 *
 * @param groupId Root group/org agent UUID.
 * @returns Map of member agent id → total points earned (only members with > 0).
 */
export async function getSubtreeTaskPointsByMember(
  groupId: string,
): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id FROM agents a
      JOIN grp_tree t ON a.parent_id = t.id
      WHERE a.deleted_at IS NULL
    )
    SELECT
      l.subject_id AS member_id,
      COALESCE(SUM((l.metadata->>'points')::numeric), 0) AS points
    FROM ledger l
    JOIN resources task ON task.id = l.object_id AND task.deleted_at IS NULL
    WHERE l.verb = 'earn'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
      AND (l.metadata->>'points') ~ '^[0-9]+(\\.[0-9]+)?$'
      AND task.owner_id IN (SELECT id FROM grp_tree)
    GROUP BY l.subject_id
  `)) as Array<Record<string, unknown>>;

  const byMember = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.member_id ?? "");
    const points = Number(row.points ?? 0);
    if (id && Number.isFinite(points) && points > 0) byMember.set(id, points);
  }
  return byMember;
}

/** One member's task points attributed to a single owning agent (subgroup/org). */
export interface MemberSubgroupPoints {
  /** Owning agent id — a subgroup/org in the subtree, or the root group. */
  readonly agentId: string;
  /** Owning agent display name. */
  readonly name: string;
  /** True when this is the root group itself (its directly-owned work). */
  readonly isRoot: boolean;
  /** Points this member earned from tasks OWNED by this agent. */
  readonly points: number;
}

/**
 * Breaks a member's task points down BY the owning subgroup, so the Stake view
 * can show "my points in each subgroup" instead of one opaque total (D21,
 * 2026-07-14).
 *
 * Attribution is by the task resource's DIRECT `owner_id` — the exact agent that
 * owns the work. This partitions cleanly (each point counted once, under one
 * owner) and sums back to the member's subtree total from
 * {@link getSubtreeTaskPointsByMember}. The root group's own directly-owned
 * tasks appear as a row flagged `isRoot`.
 *
 * Reads the SAME `earn` / `task-points-earned` rail as every other stake query —
 * it never writes points.
 *
 * @param groupId Root group/org agent UUID.
 * @returns Map of member agent id → per-owning-agent point rows (points desc).
 */
export async function getMemberSubgroupPointsBreakdown(
  groupId: string,
): Promise<Map<string, MemberSubgroupPoints[]>> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id FROM agents a
      JOIN grp_tree t ON a.parent_id = t.id
      WHERE a.deleted_at IS NULL
    )
    SELECT
      l.subject_id AS member_id,
      task.owner_id AS owner_id,
      owner.name AS owner_name,
      COALESCE(SUM((l.metadata->>'points')::numeric), 0) AS points
    FROM ledger l
    JOIN resources task ON task.id = l.object_id AND task.deleted_at IS NULL
    JOIN agents owner ON owner.id = task.owner_id AND owner.deleted_at IS NULL
    WHERE l.verb = 'earn'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
      AND (l.metadata->>'points') ~ '^[0-9]+(\\.[0-9]+)?$'
      AND task.owner_id IN (SELECT id FROM grp_tree)
    GROUP BY l.subject_id, task.owner_id, owner.name
  `)) as Array<Record<string, unknown>>;

  const byMember = new Map<string, MemberSubgroupPoints[]>();
  for (const row of rows) {
    const memberId = String(row.member_id ?? "");
    const agentId = String(row.owner_id ?? "");
    const points = Number(row.points ?? 0);
    if (!memberId || !agentId || !Number.isFinite(points) || points <= 0) continue;
    const list = byMember.get(memberId) ?? [];
    list.push({
      agentId,
      name: String(row.owner_name ?? agentId),
      isRoot: agentId === groupId,
      points,
    });
    byMember.set(memberId, list);
  }
  // Largest contribution first, then stable by name.
  for (const list of byMember.values()) {
    list.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }
  return byMember;
}

/**
 * Returns member stake data for a group by aggregating ledger entries.
 *
 * Membership is determined by active 'join' or 'belong' ledger edges pointing
 * at the group OR any of its descendant subgroups (subgroup contributors hold
 * stake in the org). Contribution metrics are verb counts scoped to the
 * subtree (the verb's object is a subtree group or a resource owned by one).
 *
 * PROFIT SHARE IS POINTS-BASED: each member's share is their task points
 * earned across the subtree out of the total points earned there. When no
 * points have been earned anywhere in the subtree, every share is 0.
 *
 * @param groupId Group agent UUID.
 * @returns Array of MemberStake records for all active subtree members.
 * @throws Propagates database/connection errors from the underlying query.
 */
export async function getMemberStakesForGroup(groupId: string): Promise<MemberStake[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE grp_tree AS (
      SELECT id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT a.id FROM agents a
      JOIN grp_tree t ON a.parent_id = t.id
      WHERE a.deleted_at IS NULL
    ),
    group_members AS (
      SELECT
        l.subject_id as member_id,
        MIN(l.timestamp) as joined_at
      FROM ledger l
      WHERE l.object_id IN (SELECT id FROM grp_tree)
        AND l.verb IN ('join', 'belong')
        AND l.is_active = true
      GROUP BY l.subject_id
    ),
    subtree_resources AS (
      SELECT r.id FROM resources r
      WHERE r.owner_id IN (SELECT id FROM grp_tree)
        AND r.deleted_at IS NULL
    ),
    member_contributions AS (
      SELECT
        gm.member_id,
        gm.joined_at,
        COALESCE(SUM(CASE WHEN ml.verb = 'create' THEN 1 ELSE 0 END), 0)::int as offers_created,
        COALESCE(SUM(CASE WHEN ml.verb = 'approve' THEN 1 ELSE 0 END), 0)::int as offers_accepted,
        COALESCE(SUM(CASE WHEN ml.verb = 'endorse' THEN 1 ELSE 0 END), 0)::int as thanks_given,
        COALESCE(SUM(CASE WHEN ml.verb = 'propose' THEN 1 ELSE 0 END), 0)::int as proposals_created,
        COALESCE(SUM(CASE WHEN ml.verb = 'vote' THEN 1 ELSE 0 END), 0)::int as votes_participated
      FROM group_members gm
      LEFT JOIN ledger ml ON ml.subject_id = gm.member_id
        AND (
          ml.object_id IN (SELECT id FROM grp_tree)
          OR ml.object_id IN (SELECT id FROM subtree_resources)
        )
      GROUP BY gm.member_id, gm.joined_at
    ),
    member_points AS (
      SELECT
        l.subject_id as member_id,
        COALESCE(SUM((l.metadata->>'points')::numeric), 0) as points_earned
      FROM ledger l
      JOIN resources task ON task.id = l.object_id AND task.deleted_at IS NULL
      WHERE l.verb = 'earn'
        AND l.is_active = true
        AND l.metadata->>'interactionType' = ${TASK_POINTS_INTERACTION}
        AND (l.metadata->>'points') ~ '^[0-9]+(\\.[0-9]+)?$'
        AND task.owner_id IN (SELECT id FROM grp_tree)
      GROUP BY l.subject_id
    ),
    -- Thanks a member RECEIVED for work in this group. Was unscoped: every
    -- endorsement a member had ever received, anywhere on the platform,
    -- counted toward their share of THIS group's stake (the same class of bug
    -- member_contributions above already avoids via grp_tree/subtree).
    thanks_received AS (
      SELECT
        l.object_id as member_id,
        COUNT(*)::int as count
      FROM ledger l
      WHERE l.object_id IN (SELECT member_id FROM group_members)
        AND l.verb = 'endorse'
        AND l.is_active = true
        AND (
          l.metadata->>'groupId' IN (SELECT id::text FROM grp_tree)
          OR (
            -- Guarded cast: contextId is free-form metadata and a non-uuid
            -- value would abort the whole query rather than skip a row.
            l.metadata->>'contextId' ~ '^[0-9a-fA-F-]{36}$'
            AND (l.metadata->>'contextId')::uuid IN (SELECT id FROM subtree_resources)
          )
        )
      GROUP BY l.object_id
    )
    SELECT
      mc.member_id,
      mc.joined_at,
      mc.offers_created,
      mc.offers_accepted,
      COALESCE(tr.count, 0)::int as thanks_received,
      mc.thanks_given,
      mc.proposals_created,
      mc.votes_participated,
      COALESCE(mp.points_earned, 0) as points_earned,
      a.name as user_name,
      COALESCE(a.metadata->>'username', a.name) as username,
      COALESCE(a.description, '') as bio,
      COALESCE(a.image, '') as avatar
    FROM member_contributions mc
    JOIN agents a ON mc.member_id = a.id
    LEFT JOIN thanks_received tr ON tr.member_id = mc.member_id
    LEFT JOIN member_points mp ON mp.member_id = mc.member_id
    WHERE a.deleted_at IS NULL
    ORDER BY COALESCE(mp.points_earned, 0) DESC,
      (mc.offers_created + mc.offers_accepted + COALESCE(tr.count, 0) + mc.proposals_created + mc.votes_participated) DESC
  `);

  const rows = result as Record<string, unknown>[];

  // Total subtree points — the stake denominator.
  const totalPoints = rows.reduce((sum, row) => sum + Number(row.points_earned ?? 0), 0);

  return rows.map((row) => {
    const pointsEarned = Number(row.points_earned ?? 0);

    return {
      user: {
        id: row.member_id as string,
        name: row.user_name as string,
        username: row.username as string,
        bio: row.bio as string,
        avatar: row.avatar as string,
        followers: 0,
        following: 0,
      },
      profitShare: totalPoints > 0
        ? Number(((pointsEarned / totalPoints) * 100).toFixed(1))
        : 0,
      pointsEarned,
      contributionMetrics: {
        offersCreated: Number(row.offers_created ?? 0),
        offersAccepted: Number(row.offers_accepted ?? 0),
        thanksReceived: Number(row.thanks_received ?? 0),
        thanksGiven: Number(row.thanks_given ?? 0),
        proposalsCreated: Number(row.proposals_created ?? 0),
        votesParticipated: Number(row.votes_participated ?? 0),
      },
      // Raw db.execute returns timestamps as STRINGS (not Date) — calling
      // .toISOString() directly threw a TypeError on every render, which the
      // page's catch swallowed, so the Stake tab silently fell back to the
      // equal-split placeholder forever. Coerce defensively.
      joinedAt: toIsoString(row.joined_at),
      groupId,
    };
  });
}

/**
 * Sums the profit share percentages for a set of member stakes.
 *
 * @param stakes Array of MemberStake records.
 * @returns Total profit share percentage.
 */
export function calculateTotalStakes(stakes: MemberStake[]): number {
  return stakes.reduce((sum, s) => sum + s.profitShare, 0);
}
