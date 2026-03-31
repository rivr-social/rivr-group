/**
 * Stake query module for group membership contribution data.
 *
 * Purpose:
 * - Aggregates ledger entries to derive member stakes and contribution metrics.
 * - Provides group-scoped membership and contribution data for stake UI.
 *
 * Key exports:
 * - `getMemberStakesForGroup`: Returns member stake data with contribution metrics.
 * - `calculateTotalStakes`: Sums profit share percentages for a set of stakes.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for Drizzle database access.
 * - `drizzle-orm` SQL templating for aggregation queries.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import type { MemberStake } from "@/lib/types";

/**
 * Returns member stake data for a group by aggregating ledger entries.
 *
 * Membership is determined by active 'join' or 'belong' ledger edges
 * pointing at the group. Contribution metrics are derived from verb counts
 * scoped to the group context.
 *
 * Profit share is calculated proportionally from total contribution scores.
 *
 * @param groupId Group agent UUID.
 * @returns Array of MemberStake records for all active group members.
 * @throws Propagates database/connection errors from the underlying query.
 */
export async function getMemberStakesForGroup(groupId: string): Promise<MemberStake[]> {
  const result = await db.execute(sql`
    WITH group_members AS (
      SELECT
        l.subject_id as member_id,
        MIN(l.timestamp) as joined_at
      FROM ledger l
      WHERE l.object_id = ${groupId}::uuid
        AND l.verb IN ('join', 'belong')
        AND l.is_active = true
      GROUP BY l.subject_id
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
      GROUP BY gm.member_id, gm.joined_at
    ),
    thanks_received AS (
      SELECT
        l.object_id as member_id,
        COUNT(*)::int as count
      FROM ledger l
      WHERE l.object_id IN (SELECT member_id FROM group_members)
        AND l.verb = 'endorse'
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
      a.name as user_name,
      COALESCE(a.metadata->>'username', a.name) as username,
      COALESCE(a.description, '') as bio,
      COALESCE(a.image, '') as avatar
    FROM member_contributions mc
    JOIN agents a ON mc.member_id = a.id
    LEFT JOIN thanks_received tr ON tr.member_id = mc.member_id
    WHERE a.deleted_at IS NULL
    ORDER BY (mc.offers_created + mc.offers_accepted + COALESCE(tr.count, 0) + mc.proposals_created + mc.votes_participated) DESC
  `);

  const rows = result as Record<string, unknown>[];

  // Calculate total contribution score for proportional profit share.
  const totalScore = rows.reduce((sum, row) => {
    return sum
      + Number(row.offers_created ?? 0)
      + Number(row.offers_accepted ?? 0)
      + Number(row.thanks_received ?? 0)
      + Number(row.proposals_created ?? 0)
      + Number(row.votes_participated ?? 0);
  }, 0);

  return rows.map((row) => {
    const memberScore =
      Number(row.offers_created ?? 0)
      + Number(row.offers_accepted ?? 0)
      + Number(row.thanks_received ?? 0)
      + Number(row.proposals_created ?? 0)
      + Number(row.votes_participated ?? 0);

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
      profitShare: totalScore > 0
        ? Number(((memberScore / totalScore) * 100).toFixed(1))
        : 0,
      contributionMetrics: {
        offersCreated: Number(row.offers_created ?? 0),
        offersAccepted: Number(row.offers_accepted ?? 0),
        thanksReceived: Number(row.thanks_received ?? 0),
        thanksGiven: Number(row.thanks_given ?? 0),
        proposalsCreated: Number(row.proposals_created ?? 0),
        votesParticipated: Number(row.votes_participated ?? 0),
      },
      joinedAt: (row.joined_at as Date).toISOString(),
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
