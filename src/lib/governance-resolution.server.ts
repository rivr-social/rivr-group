/**
 * @fileoverview Server-side reads for governance P4 resolution: board-role
 * holders and finalization-approval tallies. Shared by the group page (per-item
 * finalize progress stamping) and `app/actions/governance-resolution.ts` (the
 * finalize/board actions). Kept out of the `"use server"` actions file so pages
 * can import plain helpers.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { isBoardRole } from "@/lib/governance-resolution";

export const FINALIZE_INTERACTION = "governance-finalize";

/** Active board-role holders of a group: memberId → role. */
export async function boardRoleHolders(groupId: string): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (subject_id) subject_id, metadata->>'boardRole' AS board_role
    FROM ledger
    WHERE object_id = ${groupId}::uuid
      AND verb IN ('join', 'belong')
      AND is_active = true
      AND metadata->>'boardRole' IS NOT NULL
    ORDER BY subject_id, timestamp DESC
  `)) as Array<Record<string, unknown>>;
  const holders = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.subject_id ?? "");
    const role = String(row.board_role ?? "");
    if (id && isBoardRole(role)) holders.set(id, role);
  }
  return holders;
}

/**
 * Distinct CURRENT-board approvals per governance item:
 * targetId → approval count. Approvals from since-removed board members don't
 * count (the 2/3 bar is over the CURRENT board).
 */
export async function finalizeApprovalsByTarget(
  groupId: string,
  holders: ReadonlyMap<string, string>,
): Promise<Map<string, number>> {
  if (holders.size === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT metadata->>'targetId' AS target_id, subject_id
    FROM ledger
    WHERE object_id = ${groupId}::uuid
      AND verb = 'approve'
      AND is_active = true
      AND metadata->>'interactionType' = ${FINALIZE_INTERACTION}
  `)) as Array<Record<string, unknown>>;
  const byTarget = new Map<string, Set<string>>();
  for (const row of rows) {
    const target = String(row.target_id ?? "");
    const approver = String(row.subject_id ?? "");
    if (!target || !holders.has(approver)) continue;
    const set = byTarget.get(target) ?? new Set<string>();
    set.add(approver);
    byTarget.set(target, set);
  }
  return new Map([...byTarget.entries()].map(([target, set]) => [target, set.size]));
}
