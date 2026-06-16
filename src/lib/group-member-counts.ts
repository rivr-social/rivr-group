import type { SerializedAgent } from "@/lib/graph-serializers";
import { getGroupMemberCounts } from "@/lib/queries/agents";

/**
 * Overwrites each group/ring/family agent's `metadata.memberCount` with a live
 * count computed in a single batched query.
 *
 * List/card surfaces read `metadata.memberCount` via `agentToGroup`, but that
 * field is never maintained on join/leave — so without this annotation cards
 * show "0 members" (or a stale value that never reflects a join). Counting
 * mirrors `getGroupMembers` (hierarchical children UNION active belong/join
 * ledger edges, excluding pending membership requests).
 */
export async function annotateMemberCounts(
  groups: SerializedAgent[]
): Promise<SerializedAgent[]> {
  if (groups.length === 0) return groups;
  const counts = await getGroupMemberCounts(groups.map((g) => g.id)).catch(
    () => new Map<string, number>()
  );
  if (counts.size === 0) return groups;
  return groups.map((g) => {
    const live = counts.get(g.id);
    if (typeof live !== "number") return g;
    return { ...g, metadata: { ...(g.metadata ?? {}), memberCount: live } };
  });
}
