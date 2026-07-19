/**
 * @fileoverview Server-side vote-weight resolution for the governance weight
 * engine (`governance-weight.ts`, P3). Resolves a voter's weight against the
 * owning group at CAST time; the result is frozen onto the vote ledger row so
 * tallies recompute deterministically. Kept out of the actions file so pages
 * can import it directly (a `"use server"` module must only export actions).
 */

import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getSubtreeTaskPointsByMember } from "@/lib/queries/stakes";
import {
  getOrgShareClasses,
  getShareClassMemberShares,
} from "@/app/actions/wallet/share-classes";
import { normalizeWeight, type WeightConfig } from "@/lib/governance-weight";

/** Full pie in basis points (100% of the org's voting power). */
const FULL_VOTE_BPS = 10_000;

/** The org's share classes carrying a positive `voteBps` (decision #1). */
export async function listVotingShareClasses(
  groupId: string,
): Promise<Array<{ id: string; name: string; voteBps: number }>> {
  const classes = await getOrgShareClasses(groupId).catch(() => []);
  const out: Array<{ id: string; name: string; voteBps: number }> = [];
  for (const cls of classes) {
    const voteBps = await readClassVoteBps(cls.id);
    if (voteBps > 0) out.push({ id: cls.id, name: cls.name ?? "Share class", voteBps });
  }
  return out;
}

/** Read a share class agent's `metadata.voteBps` (0 when unset/invalid). */
async function readClassVoteBps(classId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT (metadata ->> 'voteBps')::int AS vote_bps
    FROM agents
    WHERE id = ${classId}::uuid AND deleted_at IS NULL
  `)) as Array<Record<string, unknown>>;
  const v = Number(rows[0]?.vote_bps ?? 0);
  return Number.isInteger(v) && v >= 1 && v <= FULL_VOTE_BPS ? v : 0;
}

/** Governance badges of the group with their `votingWeight`. */
async function listGovernanceBadgeWeights(
  groupId: string,
): Promise<Array<{ id: string; votingWeight: number }>> {
  const rows = await db
    .select({
      id: resources.id,
      votingWeight: sql<number>`COALESCE((${resources.metadata}->>'votingWeight')::numeric, 1)`,
    })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, groupId),
        eq(resources.type, "badge"),
        sql`${resources.metadata}->>'badgeType' = 'governance'`,
        sql`${resources.deletedAt} IS NULL`,
      ),
    );
  return rows.map((r) => ({ id: r.id, votingWeight: Number(r.votingWeight) }));
}

/** Badge ids (among `badgeIds`) the voter actively holds. */
async function heldBadgeIds(userId: string, badgeIds: string[]): Promise<Set<string>> {
  if (badgeIds.length === 0) return new Set();
  const assignments = await db
    .select({ objectId: ledger.objectId })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, "assign"),
        eq(ledger.isActive, true),
        inArray(ledger.objectId, badgeIds),
      ),
    );
  return new Set(assignments.map((a) => a.objectId).filter((id): id is string => id !== null));
}

/**
 * Resolve the voter's weight under `config` (P3). Semantics per kind are
 * documented on the pure module; every result is normalized ≥ 0 with
 * 2-decimal stability. Zero means "participates, moves nothing".
 */
export async function resolveVoterWeight(
  userId: string,
  groupId: string,
  config: WeightConfig,
): Promise<number> {
  switch (config.kind) {
    case "equal":
      return 1;
    case "stake": {
      const points = await getSubtreeTaskPointsByMember(groupId);
      return normalizeWeight(points.get(userId) ?? 0);
    }
    case "voting-shares": {
      const classes = await listVotingShareClasses(groupId);
      let weight = 0;
      for (const cls of classes) {
        const holders = await getShareClassMemberShares(cls.id);
        const total = holders.reduce((a, h) => a + h.shares, 0);
        if (total <= 0) continue;
        const mine = holders.find((h) => h.memberId === userId)?.shares ?? 0;
        if (mine <= 0) continue;
        weight += (cls.voteBps * mine) / total;
      }
      return normalizeWeight(weight);
    }
    case "badge-weight": {
      const badges = await listGovernanceBadgeWeights(groupId);
      if (badges.length === 0) return 0;
      const held = await heldBadgeIds(
        userId,
        badges.map((b) => b.id),
      );
      if (config.badgeId) {
        const badge = badges.find((b) => b.id === config.badgeId);
        return badge && held.has(badge.id) ? normalizeWeight(badge.votingWeight) : 0;
      }
      const weights = badges.filter((b) => held.has(b.id)).map((b) => b.votingWeight);
      return weights.length > 0 ? normalizeWeight(Math.max(...weights)) : 0;
    }
  }
}
