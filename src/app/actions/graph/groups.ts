"use server";

import type { Agent, Resource } from "@/db/schema";
import {
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import { q } from "@/lib/graph-query";
import { isAnonymousGroupPageVisible } from "@/lib/publication-policy";
import {
  getAgent,
  getAgentChildren,
  getGroupMembers,
} from "@/lib/queries/agents";
import {
  getResourcesForGroup,
} from "@/lib/queries/resources";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { toISOString } from "@/lib/graph-serializers";
import {
  tryActorId,
  canViewAgent,
  filterViewableAgents,
  filterViewableResources,
  filterPubliclyCrawlableAgents,
  filterPubliclyCrawlableResources,
} from "./helpers";
import { isUuid, isAnonymousCrawlableVisibility } from "./types";

import type { SerializedGroupRelationship, MemberInfo } from "./types";

function agentToMemberInfo(agent: Agent): MemberInfo {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  return {
    id: agent.id,
    name: agent.name,
    username:
      typeof metadata.username === "string"
        ? metadata.username
        : agent.name.toLowerCase().replace(/\s+/g, ""),
    avatar: agent.image || "/placeholder.svg",
  };
}

/**
 * Fetches group detail bundle including members, subgroups, events, and resources.
 *
 * Error handling pattern:
 * - Resource permission filtering is wrapped in `try/catch`; failures log and fall back to `[]`.
 *
 * @param groupId Group agent id.
 * @returns Group detail object, or `null` if inaccessible/missing.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const detail = await fetchGroupDetail(groupId);
 * ```
 */
export async function fetchGroupDetail(groupId: string) {
  if (!isUuid(groupId)) return null;
  const actorId = await tryActorId();

  const [group, children, resources, membersByLedger] = await Promise.all([
    getAgent(groupId),
    getAgentChildren(groupId),
    getResourcesForGroup(groupId),
    getGroupMembers(groupId),
  ]);

  if (!group) return null;
  const groupMeta = (group.metadata ?? {}) as Record<string, unknown>;
  const joinMeta =
    groupMeta.joinSettings && typeof groupMeta.joinSettings === "object"
      ? (groupMeta.joinSettings as Record<string, unknown>)
      : {};
  const hiddenJoinGroup = joinMeta.visibility === "hidden";
  const hasActorView = actorId ? await canViewAgent(actorId, groupId) : false;

  if (actorId) {
    if (!hasActorView && !hiddenJoinGroup) return null;
  }

  if (!actorId && !isAnonymousGroupPageVisible(groupMeta, group.visibility) && !hiddenJoinGroup) return null;

  const permissionActorId = hasActorView ? actorId : null;

  const visibleChildren = permissionActorId
    ? await filterViewableAgents(permissionActorId, children)
    : await filterPubliclyCrawlableAgents(children);
  let visibleResources: Resource[] = [];
  try {
    visibleResources = permissionActorId
      ? await filterViewableResources(permissionActorId, resources)
      : await filterPubliclyCrawlableResources(resources);
  } catch (error) {
    console.error("[fetchGroupDetail] resource permission filter failed:", error);
    visibleResources = [];
  }

  // Merge membership sources (hierarchy + ledger) and dedupe by id.
  const dedupedMembers = new Map<string, Agent>();
  for (const child of visibleChildren.filter((c) => c.type === "person")) {
    dedupedMembers.set(child.id, child);
  }
  for (const m of permissionActorId ? membersByLedger : membersByLedger.filter((member) => isAnonymousCrawlableVisibility(member))) {
    dedupedMembers.set(m.id, m);
  }

  return {
    group: serializeAgent(group),
    members: Array.from(dedupedMembers.values()).map(serializeAgent),
    subgroups: visibleChildren.filter((c) => c.type === "organization").map(serializeAgent),
    events: visibleChildren.filter((c) => c.type === "event").map(serializeAgent),
    resources: visibleResources.map(serializeResource),
  };
}

/**
 * Returns a lightweight member list for a group, suitable for display in
 * client components (admin panels, user pickers, comment feeds, etc.).
 *
 * @param groupId Group agent id.
 * @returns Array of `MemberInfo` objects visible to the caller.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 */
export async function fetchGroupMemberList(
  groupId: string
): Promise<MemberInfo[]> {
  return q("required", { table: "agents", fn: "getGroupMembers", groupId }, {
    requireViewable: groupId,
    customSerializer: (item) => agentToMemberInfo(item as Agent),
  });
}

/**
 * Returns a lightweight people list for general-purpose display (suggested
 * follows, user pickers without a group context, etc.).
 *
 * @param limit Max rows to return.
 * @returns Array of `MemberInfo` objects visible to the caller.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 */
export async function fetchPeopleMemberList(
  limit = 50
): Promise<MemberInfo[]> {
  return q("required", { table: "agents", fn: "getAgentsByType", type: "person", limit }, {
    customSerializer: (item) => agentToMemberInfo(item as Agent),
  });
}

/**
 * Fetches inter-group relationship edges from the ledger for a given group.
 *
 * Queries for active ledger entries where the group is subject or object,
 * the counterpart is also an agent, and metadata contains a `relationshipType`.
 * This covers affiliate, partner, coalition, and other group-to-group links.
 *
 * @param groupId Group agent id.
 * @returns Serialized relationship records, or `[]` when none exist.
 * @throws Propagates database/connection errors from the underlying query.
 * @example
 * ```ts
 * const relationships = await fetchGroupRelationships(groupId);
 * ```
 */
export async function fetchGroupRelationships(
  groupId: string
): Promise<SerializedGroupRelationship[]> {
  const rows = await db.execute(sql`
    SELECT
      id,
      subject_id,
      object_id,
      verb,
      metadata,
      timestamp
    FROM ledger
    WHERE is_active = true
      AND object_type = 'agent'
      AND (subject_id = ${groupId}::uuid OR object_id = ${groupId}::uuid)
      AND metadata->>'relationshipType' IS NOT NULL
    ORDER BY timestamp DESC
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      sourceGroupId: row.subject_id as string,
      targetGroupId: (row.object_id as string) ?? "",
      type: (meta.relationshipType as string) ?? "affiliate",
      description: (meta.description as string) ?? null,
      createdAt: toISOString(row.timestamp),
      createdBy: row.subject_id as string,
    };
  });
}

/**
 * Returns badges associated with a group, serialized for client consumption.
 */
export async function fetchGroupBadges(groupId: string): Promise<SerializedResource[]> {
  return q("optional", { table: "resources", fn: "getResourcesForGroup", groupId, limit: 200 }, {
    permissions: "skip",
    postFilter: (items) => (items as Resource[]).filter((r) => r.type === "badge"),
  });
}
