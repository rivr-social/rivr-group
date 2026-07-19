'use server';

/**
 * Share classes (Steward / Worker equity classes) — 2026-07-09.
 *
 * A SHARE CLASS is a hidden org-grade subgroup (`agents` row, `type:
 * 'organization'`, `metadata.groupType:'share_class'`, `metadata.hidden:true`)
 * nested under an org. It is allocated:
 *   - a NUMBER OF SHARES (`metadata.shareCount`) — informational cap, and
 *   - a PERCENTAGE OF ORG NET (`metadata.netBps`, basis points 0..10000).
 * Members hold shares via a `belong` ledger edge to the class carrying
 * `metadata.shares`. When the org runs a Layer-2 net distribution, each share
 * class's `netBps` is split among its members PROPORTIONAL TO THEIR SHARES
 * (reusing the exact-sum `resolveNetAllocation`/`splitBpsByWeight` rail), on top
 * of the authored net-allocation tree.
 *
 * Steward and Worker memberships are the canonical hidden share classes: an
 * org grants a member Steward/Worker status by giving them shares in the org's
 * hidden Steward/Worker class. The member's treasury renders a "Shares" tab from
 * {@link getMemberShareHoldingsAction}.
 *
 * No enum/schema migration — all state is metadata + existing `belong` ledger
 * edges. All money movement stays in the existing net-distribution rail; this
 * module only authors classes, holdings, and allocations.
 */
import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, ledger } from '@/db/schema';
import type { NewAgent, NewLedgerEntry } from '@/db/schema';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { hasGroupWriteAccess } from '@/app/actions/resource-creation/helpers';
import { BPS_DIVISOR } from '@/lib/wallet-constants';
import { getCurrentUserId } from './helpers';
import { isUuid } from './types';
import {
  SHARE_CLASS_GROUP_TYPE,
  type ShareClassRow,
  type ShareHolder,
} from './share-classes-types';

/** Ledger verb + interaction marking a member's share holding in a class. */
const SHARE_HOLD_VERB = 'belong';
const SHARE_HOLD_INTERACTION = 'share-class-holding';
const SHARE_CLASS_NAME_MAX = 120;
/** Full pie in basis points (100%). */
const FULL_PIE_BPS = BPS_DIVISOR;

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// ---------------------------------------------------------------------------
// Reads (also used by the net-allocation resolver)
// ---------------------------------------------------------------------------

/**
 * Lists an org's share-class subgroups with their allocation.
 *
 * @param orgId The org/group agent UUID.
 * @returns Share-class rows (id, name, shareCount, netBps, hidden, tierKey).
 */
export async function getOrgShareClasses(orgId: string): Promise<ShareClassRow[]> {
  if (!isUuid(orgId)) return [];
  const rows = await db
    .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.parentId, orgId),
        sql`${agents.deletedAt} IS NULL`,
        sql`lower(${agents.metadata} ->> 'groupType') = ${SHARE_CLASS_GROUP_TYPE}`,
      ),
    );
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      shareCount: isIntInRange(m.shareCount, 0, Number.MAX_SAFE_INTEGER) ? (m.shareCount as number) : 0,
      netBps: isIntInRange(m.netBps, 0, FULL_PIE_BPS) ? (m.netBps as number) : 0,
      voteBps: isIntInRange(m.voteBps, 0, FULL_PIE_BPS) ? (m.voteBps as number) : 0,
      hidden: m.hidden === true,
      tierKey: typeof m.tierKey === 'string' ? (m.tierKey as string) : null,
    };
  });
}

/**
 * Resolves the active share holders of a class (member id + share count),
 * summing any duplicate active holdings defensively.
 *
 * @param classId The share-class subgroup UUID.
 * @returns Holders with positive share counts.
 */
export async function getShareClassMemberShares(classId: string): Promise<ShareHolder[]> {
  if (!isUuid(classId)) return [];
  const rows = (await db.execute(sql`
    SELECT subject_id,
           COALESCE((metadata ->> 'shares')::int, 0) AS shares
    FROM ledger
    WHERE object_id = ${classId}::uuid
      AND verb = ${SHARE_HOLD_VERB}
      AND is_active = true
      AND metadata ->> 'interactionType' = ${SHARE_HOLD_INTERACTION}
  `)) as Array<Record<string, unknown>>;
  const byMember = new Map<string, number>();
  for (const row of rows) {
    const memberId = String(row.subject_id ?? '');
    const shares = Number(row.shares ?? 0);
    if (!memberId || !Number.isFinite(shares) || shares <= 0) continue;
    byMember.set(memberId, (byMember.get(memberId) ?? 0) + shares);
  }
  return Array.from(byMember, ([memberId, shares]) => ({ memberId, shares }));
}

/** Sum of all share-class netBps for an org (for pie validation). */
async function sumShareClassBps(orgId: string, excludeClassId?: string): Promise<number> {
  const classes = await getOrgShareClasses(orgId);
  return classes
    .filter((c) => c.id !== excludeClassId)
    .reduce((sum, c) => sum + c.netBps, 0);
}

/** Σ voteBps across the org's OTHER classes (P3 pie guard, mirrors netBps). */
async function sumShareClassVoteBps(orgId: string, excludeClassId?: string): Promise<number> {
  const classes = await getOrgShareClasses(orgId);
  return classes
    .filter((c) => c.id !== excludeClassId)
    .reduce((sum, c) => sum + c.voteBps, 0);
}

/**
 * Lists an org's members (active join/belong holders) for the share-assignment
 * picker. Admin-gated.
 *
 * @param orgId The org/group agent UUID.
 */
export async function getOrgMembersAction(
  orgId: string,
): Promise<{ success: boolean; error?: string; members?: Array<{ id: string; name: string }> }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(orgId)) return { success: false, error: 'Invalid org.' };
  const canManage = await hasGroupWriteAccess(userId, orgId);
  if (!canManage) return { success: false, error: 'You do not have permission to manage this org.' };

  const rows = (await db.execute(sql`
    SELECT DISTINCT a.id, a.name
    FROM ledger l
    JOIN agents a ON a.id = l.subject_id
    WHERE l.object_id = ${orgId}::uuid
      AND l.verb IN ('join', 'belong')
      AND l.is_active = true
      AND a.deleted_at IS NULL
    ORDER BY a.name
    LIMIT 500
  `)) as Array<Record<string, unknown>>;
  return {
    success: true,
    members: rows.map((r) => ({ id: String(r.id), name: String(r.name ?? 'Member') })),
  };
}

// ---------------------------------------------------------------------------
// Authoring (org admins)
// ---------------------------------------------------------------------------

/**
 * Creates a hidden share-class subgroup under an org.
 *
 * @param orgId The org/group agent UUID (parent).
 * @param input name, shareCount (>=0), netBps (0..10000 - remaining pie), optional tierKey.
 * @returns The new class id, or an error.
 */
export async function createShareClassAction(
  orgId: string,
  input: { name: string; shareCount: number; netBps: number; tierKey?: 'steward' | 'worker' | null },
): Promise<{ success: boolean; classId?: string; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(orgId)) return { success: false, error: 'Invalid org.' };

  const name = input?.name?.trim();
  if (!name) return { success: false, error: 'A share-class name is required.' };
  if (name.length > SHARE_CLASS_NAME_MAX) {
    return { success: false, error: `Names are limited to ${SHARE_CLASS_NAME_MAX} characters.` };
  }
  const shareCount = input.shareCount;
  const netBps = input.netBps;
  if (!isIntInRange(shareCount, 0, Number.MAX_SAFE_INTEGER)) {
    return { success: false, error: 'Share count must be a non-negative whole number.' };
  }
  if (!isIntInRange(netBps, 0, FULL_PIE_BPS)) {
    return { success: false, error: 'Net % must be between 0 and 100.' };
  }

  const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, error: 'Rate limit exceeded. Please try again later.' };

  const canManage = await hasGroupWriteAccess(userId, orgId);
  if (!canManage) return { success: false, error: 'You do not have permission to manage this org.' };

  const existingBps = await sumShareClassBps(orgId);
  if (existingBps + netBps > FULL_PIE_BPS) {
    return {
      success: false,
      error: `Net % over-allocates: existing share classes hold ${(existingBps / 100).toFixed(2)}%, leaving ${((FULL_PIE_BPS - existingBps) / 100).toFixed(2)}%.`,
    };
  }

  const [org] = await db
    .select({ id: agents.id, depth: agents.depth, pathIds: agents.pathIds })
    .from(agents)
    .where(and(eq(agents.id, orgId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!org) return { success: false, error: 'Org not found.' };

  const result = await updateFacade.execute(
    {
      type: 'createShareClassAction',
      actorId: userId,
      targetAgentId: orgId,
      payload: { orgId, name },
    },
    async () => {
      const [created] = await db
        .insert(agents)
        .values({
          name,
          type: 'organization',
          description: `Share class of ${org.id}`,
          visibility: 'private',
          parentId: orgId,
          depth: org.depth + 1,
          pathIds: [...(org.pathIds ?? []), orgId],
          metadata: {
            groupType: SHARE_CLASS_GROUP_TYPE,
            hidden: true,
            shareCount,
            netBps,
            tierKey: input.tierKey ?? null,
            creatorId: userId,
          },
        } as NewAgent)
        .returning({ id: agents.id });
      return { success: true, classId: created.id } as {
        success: boolean;
        classId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('createShareClassAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to create the share class.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.AGENT_UPDATED,
    entityType: 'agent',
    entityId: result.data?.classId ?? orgId,
    actorId: userId,
    payload: { action: 'create_share_class', orgId, name, netBps, shareCount },
  }).catch(() => {});

  revalidatePath(`/groups/${orgId}`);
  return result.data ?? { success: true };
}

/**
 * Updates a share class's allocation (shareCount and/or netBps), re-validating
 * the org's net-% pie.
 *
 * @param orgId The org UUID (for authorization + pie context).
 * @param classId The share-class UUID.
 * @param updates shareCount and/or netBps (at least one).
 */
export async function setShareClassAllocationAction(
  orgId: string,
  classId: string,
  updates: { shareCount?: number; netBps?: number; voteBps?: number },
): Promise<{ success: boolean; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(orgId) || !isUuid(classId)) return { success: false, error: 'Invalid ids.' };
  if (updates.shareCount === undefined && updates.netBps === undefined && updates.voteBps === undefined) {
    return { success: false, error: 'Nothing to update.' };
  }
  // Governance P3 (decision #1): voteBps is the class's VOTING dimension,
  // independent of the profit netBps — a class may carry economic cut,
  // governance weight, or both. Same 0..100% pie constraint across classes.
  if (updates.voteBps !== undefined && !isIntInRange(updates.voteBps, 0, FULL_PIE_BPS)) {
    return { success: false, error: 'Vote % must be between 0 and 100.' };
  }
  if (updates.shareCount !== undefined && !isIntInRange(updates.shareCount, 0, Number.MAX_SAFE_INTEGER)) {
    return { success: false, error: 'Share count must be a non-negative whole number.' };
  }
  if (updates.netBps !== undefined && !isIntInRange(updates.netBps, 0, FULL_PIE_BPS)) {
    return { success: false, error: 'Net % must be between 0 and 100.' };
  }

  const canManage = await hasGroupWriteAccess(userId, orgId);
  if (!canManage) return { success: false, error: 'You do not have permission to manage this org.' };

  const [cls] = await db
    .select({ id: agents.id, parentId: agents.parentId, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, classId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!cls || cls.parentId !== orgId) return { success: false, error: 'Share class not found in this org.' };
  const m = (cls.metadata ?? {}) as Record<string, unknown>;
  if (String(m.groupType ?? '').toLowerCase() !== SHARE_CLASS_GROUP_TYPE) {
    return { success: false, error: 'Not a share class.' };
  }

  if (updates.netBps !== undefined) {
    const otherBps = await sumShareClassBps(orgId, classId);
    if (otherBps + updates.netBps > FULL_PIE_BPS) {
      return {
        success: false,
        error: `Net % over-allocates: other share classes hold ${(otherBps / 100).toFixed(2)}%, leaving ${((FULL_PIE_BPS - otherBps) / 100).toFixed(2)}%.`,
      };
    }
  }

  if (updates.voteBps !== undefined) {
    const otherVoteBps = await sumShareClassVoteBps(orgId, classId);
    if (otherVoteBps + updates.voteBps > FULL_PIE_BPS) {
      return {
        success: false,
        error: `Vote % over-allocates: other share classes hold ${(otherVoteBps / 100).toFixed(2)}%, leaving ${((FULL_PIE_BPS - otherVoteBps) / 100).toFixed(2)}%.`,
      };
    }
  }

  const nextMeta = {
    ...m,
    ...(updates.shareCount !== undefined ? { shareCount: updates.shareCount } : {}),
    ...(updates.netBps !== undefined ? { netBps: updates.netBps } : {}),
    ...(updates.voteBps !== undefined ? { voteBps: updates.voteBps } : {}),
  };
  await db.update(agents).set({ metadata: nextMeta, updatedAt: new Date() }).where(eq(agents.id, classId));
  revalidatePath(`/groups/${orgId}`);
  return { success: true };
}

/**
 * Sets (or clears) a member's share holding in a class. `shares = 0` retires the
 * holding. Upserts the single active `belong` holding edge for (member, class).
 *
 * @param orgId The org UUID (authorization).
 * @param classId The share-class UUID.
 * @param memberId The member agent UUID.
 * @param shares Non-negative whole number of shares (0 removes the holding).
 */
export async function setMemberSharesAction(
  orgId: string,
  classId: string,
  memberId: string,
  shares: number,
): Promise<{ success: boolean; error?: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(orgId) || !isUuid(classId) || !isUuid(memberId)) {
    return { success: false, error: 'Invalid ids.' };
  }
  if (!isIntInRange(shares, 0, Number.MAX_SAFE_INTEGER)) {
    return { success: false, error: 'Shares must be a non-negative whole number.' };
  }

  const canManage = await hasGroupWriteAccess(userId, orgId);
  if (!canManage) return { success: false, error: 'You do not have permission to manage this org.' };

  const [cls] = await db
    .select({ id: agents.id, parentId: agents.parentId, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, classId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!cls || cls.parentId !== orgId) return { success: false, error: 'Share class not found in this org.' };

  await db.transaction(async (tx) => {
    // Deactivate any existing holdings for this (member, class).
    await tx.execute(sql`
      UPDATE ledger SET is_active = false
      WHERE subject_id = ${memberId}::uuid
        AND object_id = ${classId}::uuid
        AND verb = ${SHARE_HOLD_VERB}
        AND metadata ->> 'interactionType' = ${SHARE_HOLD_INTERACTION}
        AND is_active = true
    `);
    if (shares > 0) {
      await tx.insert(ledger).values({
        subjectId: memberId,
        verb: SHARE_HOLD_VERB,
        objectId: classId,
        objectType: 'agent',
        isActive: true,
        metadata: {
          interactionType: SHARE_HOLD_INTERACTION,
          shares,
          orgId,
          grantedBy: userId,
        },
      } as NewLedgerEntry);
    }
  });

  revalidatePath(`/groups/${orgId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Overviews
// ---------------------------------------------------------------------------

/**
 * Admin overview of an org's share classes: each class with its allocation and
 * its members' share holdings.
 *
 * @param orgId The org UUID.
 */
export async function getShareClassOverviewAction(orgId: string): Promise<{
  success: boolean;
  error?: string;
  totalNetBps?: number;
  classes?: Array<ShareClassRow & { holders: Array<{ memberId: string; memberName: string; shares: number }> }>;
}> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(orgId)) return { success: false, error: 'Invalid org.' };
  const canManage = await hasGroupWriteAccess(userId, orgId);
  if (!canManage) return { success: false, error: 'You do not have permission to manage this org.' };

  const classes = await getOrgShareClasses(orgId);
  const out: Array<ShareClassRow & { holders: Array<{ memberId: string; memberName: string; shares: number }> }> = [];
  for (const c of classes) {
    const holders = await getShareClassMemberShares(c.id);
    const names = holders.length
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(sql`${agents.id} IN (${sql.join(holders.map((h) => sql`${h.memberId}::uuid`), sql`, `)})`)
      : [];
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    out.push({
      ...c,
      holders: holders.map((h) => ({
        memberId: h.memberId,
        memberName: nameById.get(h.memberId) ?? 'Member',
        shares: h.shares,
      })),
    });
  }
  return { success: true, totalNetBps: classes.reduce((s, c) => s + c.netBps, 0), classes: out };
}

/**
 * The "Shares" treasury tab data for a member: every share class they hold
 * shares in (across their orgs), with their share count, the class's total
 * shares/net %, and their pro-rata slice of the class's net %.
 *
 * @param memberId Optional member id; defaults to the current user.
 */
export async function getMemberShareHoldingsAction(memberId?: string): Promise<{
  success: boolean;
  error?: string;
  holdings?: Array<{
    classId: string;
    className: string;
    orgId: string;
    orgName: string;
    myShares: number;
    classTotalShares: number;
    classNetBps: number;
    myNetBps: number;
  }>;
}> {
  const userId = await getCurrentUserId();
  const target = memberId ?? userId ?? '';
  if (!isUuid(target)) return { success: false, error: 'Not signed in.' };
  // A member may read their OWN holdings; reading another's requires nothing
  // sensitive here, but we keep it self-only unless the caller is the member.
  if (memberId && memberId !== userId) {
    return { success: false, error: 'You can only view your own share holdings.' };
  }

  const rows = (await db.execute(sql`
    SELECT object_id AS class_id,
           COALESCE((metadata ->> 'shares')::int, 0) AS shares
    FROM ledger
    WHERE subject_id = ${target}::uuid
      AND verb = ${SHARE_HOLD_VERB}
      AND is_active = true
      AND metadata ->> 'interactionType' = ${SHARE_HOLD_INTERACTION}
  `)) as Array<Record<string, unknown>>;

  const holdings: Array<{
    classId: string;
    className: string;
    orgId: string;
    orgName: string;
    myShares: number;
    classTotalShares: number;
    classNetBps: number;
    myNetBps: number;
  }> = [];

  for (const row of rows) {
    const classId = String(row.class_id ?? '');
    const myShares = Number(row.shares ?? 0);
    if (!isUuid(classId) || myShares <= 0) continue;
    const [cls] = await db
      .select({ id: agents.id, name: agents.name, parentId: agents.parentId, metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, classId), sql`${agents.deletedAt} IS NULL`))
      .limit(1);
    if (!cls) continue;
    const m = (cls.metadata ?? {}) as Record<string, unknown>;
    const classNetBps = isIntInRange(m.netBps, 0, FULL_PIE_BPS) ? (m.netBps as number) : 0;
    const allHolders = await getShareClassMemberShares(classId);
    const classTotalShares = allHolders.reduce((s, h) => s + h.shares, 0);
    const myNetBps = classTotalShares > 0 ? Math.round((classNetBps * myShares) / classTotalShares) : 0;
    let orgName = 'Organization';
    if (cls.parentId) {
      const [org] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, cls.parentId)).limit(1);
      orgName = org?.name ?? orgName;
    }
    holdings.push({
      classId,
      className: cls.name,
      orgId: cls.parentId ?? '',
      orgName,
      myShares,
      classTotalShares,
      classNetBps,
      myNetBps,
    });
  }

  return { success: true, holdings };
}
