/**
 * @fileoverview Server-side fact gathering for the governance eligibility
 * engine (`governance-eligibility.ts`). Resolves an actor's membership/admin/
 * badge/share/ABAC facts against the owning group so the pure evaluator can
 * decide, and lists the gate options (governance badges + share classes) the
 * create-poll/proposal pickers offer.
 *
 * Kept out of the actions file: pages import these helpers directly, and a
 * `"use server"` module must only export server actions.
 */

import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isGroupMember, check } from "@/lib/permissions";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { getOrgShareClasses } from "@/app/actions/wallet/share-classes";
import {
  combinedFactNeeds,
  gateFactNeeds,
  evaluateEligibilityGate,
  type EligibilityFactNeeds,
  type EligibilityFacts,
  type EligibilityGate,
  type EligibilityVerdict,
} from "@/lib/governance-eligibility";

const EMPTY_FACTS: EligibilityFacts = {
  isAuthenticated: false,
  isMember: false,
  isAdmin: false,
  heldBadgeIds: [],
  shareHoldings: {},
  abacAllowed: false,
};

/** The group's governance badges (id + name), oldest first. */
export async function listGovernanceBadges(
  groupId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: resources.id, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, groupId),
        eq(resources.type, "badge"),
        sql`${resources.metadata}->>'badgeType' = 'governance'`,
        sql`${resources.deletedAt} IS NULL`,
      ),
    );
  return rows.map((r) => ({ id: r.id, name: r.name ?? "Badge" }));
}

/**
 * Gate options the create-poll/proposal pickers offer: the group's governance
 * badges and the org's share classes (including hidden Steward/Worker classes —
 * gating a vote on them is exactly their purpose).
 */
export async function listGovernanceGateOptions(groupId: string): Promise<{
  badges: Array<{ id: string; name: string }>;
  shareClasses: Array<{ id: string; name: string }>;
  hasVotingShares: boolean;
}> {
  const [badges, classes] = await Promise.all([
    listGovernanceBadges(groupId),
    getOrgShareClasses(groupId).catch(() => []),
  ]);
  return {
    badges,
    shareClasses: classes.map((c) => ({ id: c.id, name: c.name ?? "Share class" })),
    // P3: the voting-shares weight kind is only offerable when a class
    // actually carries governance voteBps.
    hasVotingShares: classes.some((c) => c.voteBps > 0),
  };
}

/** Active governance-badge ids (of this group) the actor holds. */
async function resolveHeldGovernanceBadgeIds(userId: string, groupId: string): Promise<string[]> {
  const badges = await listGovernanceBadges(groupId);
  if (badges.length === 0) return [];
  const badgeIds = badges.map((b) => b.id);
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
  return assignments.map((a) => a.objectId).filter((id): id is string => id !== null);
}

/** classId → shares the actor actively holds, restricted to this org's classes. */
async function resolveShareHoldings(
  userId: string,
  groupId: string,
): Promise<Record<string, number>> {
  const classes = await getOrgShareClasses(groupId).catch(() => []);
  if (classes.length === 0) return {};
  const classIds = classes.map((c) => c.id);
  const rows = await db
    .select({
      objectId: ledger.objectId,
      shares: sql<number>`COALESCE((${ledger.metadata} ->> 'shares')::int, 0)`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, "belong"),
        eq(ledger.isActive, true),
        sql`${ledger.metadata} ->> 'interactionType' = 'share-class-holding'`,
        inArray(ledger.objectId, classIds),
      ),
    );
  const holdings: Record<string, number> = {};
  for (const row of rows) {
    if (!row.objectId) continue;
    holdings[row.objectId] = (holdings[row.objectId] ?? 0) + Number(row.shares ?? 0);
  }
  return holdings;
}

/**
 * Resolve only the fact families `needs` asks for (the rest stay at their
 * false/empty defaults). Anonymous actors resolve to {@link EMPTY_FACTS}.
 */
export async function resolveGovernanceEligibilityFacts(
  userId: string | null | undefined,
  groupId: string,
  needs: EligibilityFactNeeds,
): Promise<EligibilityFacts> {
  if (!userId) return { ...EMPTY_FACTS };

  const [membership, isAdmin, heldBadgeIds, shareHoldings, abacResult] = await Promise.all([
    needs.member ? isGroupMember(userId, groupId) : Promise.resolve({ isMember: false }),
    needs.admin ? isGroupAdmin(userId, groupId) : Promise.resolve(false),
    needs.badges ? resolveHeldGovernanceBadgeIds(userId, groupId) : Promise.resolve([]),
    needs.shares ? resolveShareHoldings(userId, groupId) : Promise.resolve({}),
    needs.abac
      ? check(userId, "vote", groupId, "agent").catch((error) => {
          console.error("[governance-eligibility] abac check failed:", error);
          return { allowed: false };
        })
      : Promise.resolve({ allowed: false }),
  ]);

  return {
    isAuthenticated: true,
    isMember: membership.isMember,
    isAdmin,
    heldBadgeIds,
    shareHoldings,
    abacAllowed: abacResult.allowed === true,
  };
}

/** Resolve facts for one gate and evaluate it — the single-item convenience. */
export async function evaluateGovernanceGateForUser(
  userId: string | null | undefined,
  groupId: string,
  gate: EligibilityGate,
): Promise<EligibilityVerdict> {
  const facts = await resolveGovernanceEligibilityFacts(userId, groupId, gateFactNeeds(gate));
  return evaluateEligibilityGate(gate, facts);
}

/**
 * Batch evaluation for a page render: resolve the union of the gates' fact
 * needs ONCE, then evaluate each gate against the shared facts.
 */
export async function evaluateGovernanceGatesForUser(
  userId: string | null | undefined,
  groupId: string,
  gates: readonly EligibilityGate[],
): Promise<EligibilityVerdict[]> {
  if (gates.length === 0) return [];
  const facts = await resolveGovernanceEligibilityFacts(userId, groupId, combinedFactNeeds(gates));
  return gates.map((gate) => evaluateEligibilityGate(gate, facts));
}
