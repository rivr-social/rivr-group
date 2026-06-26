'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, ledger } from '@/db/schema';
import type { NewLedgerEntry } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { hasGroupWriteAccess } from '@/app/actions/resource-creation/helpers';
import {
  parseNetAllocationTree,
  validateNetAllocationTree,
  resolveNetAllocation,
  type NetAllocationRule,
  type NetAllocationTree,
  type ResolvedNetAllocation,
} from '@/lib/net-allocation';
import { getCurrentUserId } from './helpers';
import { isUuid } from './types';

interface NetAllocationResult {
  success: boolean;
  message?: string;
  error?: string;
  totalBps?: number;
}

/**
 * Persists an org's net %-allocation tree (EPIC J7) onto the group agent's
 * `metadata.netAllocation`. The tree is parsed, validated against the full pie,
 * and written only when valid — never partially.
 *
 * Authorization: caller must hold group-write access on the org.
 *
 * @param input.groupId The org/group agent id.
 * @param input.rules The authored allocation rules (class/individual + bps).
 * @returns Result; `totalBps` reflects the validated allocated total.
 */
export async function saveNetAllocationAction(input: {
  groupId: string;
  rules: NetAllocationRule[];
}): Promise<NetAllocationResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, error: 'You must be logged in to edit allocation.' };
  if (!isUuid(input.groupId)) return { success: false, error: 'Invalid group id.' };

  const check = await rateLimit(
    `resources:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, error: 'Rate limit exceeded. Please try again later.' };

  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, error: 'You do not have permission to edit this org allocation.' };
  }

  // Re-parse through the validated parser so only well-formed rules persist,
  // even if the client sent extras.
  const tree = parseNetAllocationTree({ netAllocation: { rules: input.rules } });
  const validation = validateNetAllocationTree(tree);
  if (!validation.valid) {
    return { success: false, error: validation.error, totalBps: validation.totalBps };
  }

  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, input.groupId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!group) return { success: false, error: 'Group not found.' };

  const meta = (group.metadata ?? {}) as Record<string, unknown>;
  const updatedMeta = {
    ...meta,
    netAllocation: { rules: tree.rules, updatedAt: new Date().toISOString(), updatedBy: userId },
  };

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ metadata: updatedMeta, updatedAt: new Date() })
      .where(eq(agents.id, input.groupId));

    await tx.insert(ledger).values({
      verb: 'update',
      subjectId: userId,
      objectId: input.groupId,
      objectType: 'agent',
      isActive: true,
      metadata: {
        source: 'stake-net-allocation',
        interactionType: 'net-allocation-update',
        ruleCount: tree.rules.length,
        totalBps: validation.totalBps,
      },
    } as NewLedgerEntry);
  });

  revalidatePath(`/groups/${input.groupId}`);
  return {
    success: true,
    message: 'Net allocation saved.',
    totalBps: validation.totalBps,
  };
}

/**
 * Resolves a group's active members keyed by membership class (the membership
 * ledger row's `role`). Active `join`/`belong` edges pointing at the group are
 * grouped by their role; the role string IS the class key referenced by
 * `class`-type allocation rules.
 *
 * @param groupId The org/group agent id.
 * @returns Map of class key → member agent ids.
 */
export async function getGroupMembersByClass(
  groupId: string,
): Promise<Map<string, string[]>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT subject_id, COALESCE(role, 'member') AS class_key
    FROM ledger
    WHERE object_id = ${groupId}::uuid
      AND verb IN ('join', 'belong')
      AND is_active = true
    ORDER BY class_key
  `)) as Array<Record<string, unknown>>;

  const byClass = new Map<string, string[]>();
  for (const row of rows) {
    const classKey = String(row.class_key ?? 'member');
    const memberId = String(row.subject_id ?? '');
    if (!memberId) continue;
    const list = byClass.get(classKey) ?? [];
    if (!list.includes(memberId)) list.push(memberId);
    byClass.set(classKey, list);
  }
  return byClass;
}

/**
 * Resolves the saved allocation tree for a group into concrete per-individual
 * bps shares, using the group's current membership-by-class. This is the
 * read-side preview/resolution used by the Stake editor and (eventually) the
 * Layer-2 distribution RUN. It does NOT move money.
 *
 * @param groupId The org/group agent id.
 * @returns Resolved per-individual shares (deduped/summed).
 */
export async function resolveGroupNetAllocation(
  groupId: string,
): Promise<ResolvedNetAllocation[]> {
  if (!isUuid(groupId)) return [];

  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!group) return [];

  const tree: NetAllocationTree = parseNetAllocationTree(
    (group.metadata ?? {}) as Record<string, unknown>,
  );
  if (tree.rules.length === 0) return [];

  const classMembers = await getGroupMembersByClass(groupId);
  return resolveNetAllocation(tree, classMembers);
}
