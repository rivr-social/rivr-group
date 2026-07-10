"use server";

/**
 * Project LEAD + QA roles (2026-07-10).
 *
 * Every project can name a `leadId` (coordinator) and a `qaId` (attester of
 * work-completion claims). The lead is the DEFAULT QA — `resolveProjectAuthority`
 * falls back qaId → leadId — so a solo-lead project attests in one click.
 *
 * QA eligibility (Cameron's rule): any PERSON who is a member of the owning
 * group, its parent, a sibling, or a child subgroup — or an AFFILIATED GROUP
 * agent itself (in which case that group's admins exercise the QA authority,
 * see `canAttestWork`).
 *
 * Projects are dual-shape (a `resources` row or a project-typed `agents`
 * row); role metadata is patched onto whichever home the project lives in.
 */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import type { ActionResult } from "@/app/actions/interactions/types";
import { isUuid } from "@/app/actions/interactions/types";

/** Option shape for the role pickers. */
export interface ProjectRoleOption {
  id: string;
  name: string;
  type: string;
  /** Which eligibility lane surfaced this option. */
  source: "group" | "parent" | "sibling" | "child" | "affiliated";
}

export interface ProjectRolesData {
  projectId: string;
  leadId: string | null;
  qaId: string | null;
  /** Effective QA after the lead-default fallback. */
  effectiveQaId: string | null;
  canManage: boolean;
  /** Eligible persons (family-group members) for lead/QA. */
  people: ProjectRoleOption[];
  /** Eligible affiliated group agents for QA. */
  groups: ProjectRoleOption[];
}

interface ProjectHome {
  home: "resource" | "agent";
  metadata: Record<string, unknown>;
  /** Owning group agent id. */
  groupId: string;
}

/** Loads a project from either home and resolves its owning group. */
async function loadProject(projectId: string): Promise<ProjectHome | null> {
  const [row] = await db
    .select({ ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, projectId), eq(resources.type, "project"), isNull(resources.deletedAt)))
    .limit(1);
  if (row) {
    return {
      home: "resource",
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      groupId: row.ownerId,
    };
  }

  const [agentRow] = await db
    .select({ metadata: agents.metadata, parentId: agents.parentId })
    .from(agents)
    .where(and(eq(agents.id, projectId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agentRow) return null;
  const meta = (agentRow.metadata ?? {}) as Record<string, unknown>;
  const groupId =
    typeof meta.groupId === "string"
      ? meta.groupId
      : typeof meta.ownerId === "string"
        ? meta.ownerId
        : agentRow.parentId;
  if (!groupId) return null;
  return { home: "agent", metadata: meta, groupId };
}

/**
 * The QA/lead eligibility family for a group: itself, its parent, siblings
 * (other children of the parent), and child subgroups.
 */
async function getFamilyGroupIds(groupId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH me AS (
      SELECT id, parent_id FROM agents WHERE id = ${groupId}::uuid AND deleted_at IS NULL
    )
    SELECT id FROM me
    UNION
    SELECT parent_id AS id FROM me WHERE parent_id IS NOT NULL
    UNION
    SELECT a.id FROM agents a JOIN me ON a.parent_id = me.parent_id
      WHERE me.parent_id IS NOT NULL AND a.deleted_at IS NULL
    UNION
    SELECT a.id FROM agents a WHERE a.parent_id = ${groupId}::uuid AND a.deleted_at IS NULL
  `)) as Array<{ id: string }>;
  return rows.map((r) => r.id).filter(Boolean);
}

/** Active affiliated-group ids for a group (relationship ledger edges). */
async function getAffiliatedGroupIds(groupId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT subject_id, object_id
    FROM ledger
    WHERE is_active = true
      AND object_type = 'agent'
      AND (subject_id = ${groupId}::uuid OR object_id = ${groupId}::uuid)
      AND metadata->>'relationshipType' IS NOT NULL
  `)) as Array<{ subject_id: string; object_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.subject_id && row.subject_id !== groupId) ids.add(row.subject_id);
    if (row.object_id && row.object_id !== groupId) ids.add(row.object_id);
  }
  return Array.from(ids);
}

/** Person members (active join/belong) across a set of groups. */
async function getFamilyMembers(groupIds: string[]): Promise<ProjectRoleOption[]> {
  if (groupIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT DISTINCT a.id, a.name, a.type
    FROM ledger l
    JOIN agents a ON a.id = l.subject_id AND a.deleted_at IS NULL
    WHERE l.object_id IN (${sql.join(groupIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND l.verb IN ('join', 'belong')
      AND l.is_active = true
      AND a.type = 'person'
    ORDER BY a.name
  `)) as Array<{ id: string; name: string; type: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, source: "group" as const }));
}

/** Whether a candidate may hold the QA (or lead) role on the project. */
async function isEligibleRoleHolder(
  candidateId: string,
  groupId: string,
  role: "lead" | "qa",
): Promise<{ ok: boolean; reason?: string }> {
  const [candidate] = await db
    .select({ id: agents.id, type: agents.type })
    .from(agents)
    .where(and(eq(agents.id, candidateId), isNull(agents.deletedAt)))
    .limit(1);
  if (!candidate) return { ok: false, reason: "Candidate agent not found." };

  if (candidate.type === "person") {
    const familyIds = await getFamilyGroupIds(groupId);
    const [membership] = await db
      .select({ id: ledger.id })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, candidateId),
          inArray(ledger.objectId, familyIds),
          or(eq(ledger.verb, "join"), eq(ledger.verb, "belong")),
          eq(ledger.isActive, true),
        ),
      )
      .limit(1);
    return membership
      ? { ok: true }
      : { ok: false, reason: "Candidate must be a member of the group, its parent, a sibling, or a child subgroup." };
  }

  // Group-like agents may hold QA (their admins attest); never the lead.
  if (role === "lead") {
    return { ok: false, reason: "The project lead must be a person." };
  }
  const affiliated = await getAffiliatedGroupIds(groupId);
  const family = await getFamilyGroupIds(groupId);
  return affiliated.includes(candidateId) || family.includes(candidateId)
    ? { ok: true }
    : { ok: false, reason: "A group can act as QA only if it is affiliated or in the group's family tree." };
}

/** Whether the caller may edit the project's roles. */
async function canManageRoles(userId: string, project: ProjectHome): Promise<boolean> {
  if (typeof project.metadata.leadId === "string" && project.metadata.leadId === userId) return true;
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  return hasGroupWriteAccess(userId, project.groupId);
}

/**
 * Resolves the role panel state: current lead/QA, whether the viewer can
 * manage them, and the eligible option lists.
 */
export async function getProjectRolesData(projectId: string): Promise<ProjectRolesData | null> {
  if (!isUuid(projectId)) return null;
  const project = await loadProject(projectId);
  if (!project) return null;

  const leadId = typeof project.metadata.leadId === "string" ? project.metadata.leadId : null;
  const qaId = typeof project.metadata.qaId === "string" ? project.metadata.qaId : null;

  const userId = await getCurrentUserId();
  const canManage = userId ? await canManageRoles(userId, project) : false;

  let people: ProjectRoleOption[] = [];
  let groups: ProjectRoleOption[] = [];
  if (canManage) {
    const [familyIds, affiliatedIds] = await Promise.all([
      getFamilyGroupIds(project.groupId),
      getAffiliatedGroupIds(project.groupId),
    ]);
    people = await getFamilyMembers(familyIds);
    const groupIds = Array.from(new Set([...affiliatedIds, ...familyIds.filter((id) => id !== project.groupId)]));
    if (groupIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, name: agents.name, type: agents.type })
        .from(agents)
        .where(and(inArray(agents.id, groupIds), isNull(agents.deletedAt)))
        .orderBy(agents.name);
      groups = rows
        .filter((r) => r.type !== "person")
        .map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          source: affiliatedIds.includes(r.id) ? ("affiliated" as const) : ("sibling" as const),
        }));
    }
  }

  return {
    projectId,
    leadId,
    qaId,
    effectiveQaId: qaId ?? leadId,
    canManage,
    people,
    groups,
  };
}

/**
 * Sets the project's lead and/or QA. Pass `null` to clear a role (QA then
 * falls back to the lead). Gated to group admins and the current lead;
 * candidates are validated against the eligibility rules above.
 */
export async function setProjectRolesAction(
  projectId: string,
  roles: { leadId?: string | null; qaId?: string | null },
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to set project roles." };
  if (!isUuid(projectId)) return { success: false, message: "Invalid project id." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const project = await loadProject(projectId);
  if (!project) return { success: false, message: "Project not found." };

  if (!(await canManageRoles(userId, project))) {
    return { success: false, message: "Only a group admin or the project lead can set project roles." };
  }

  const patch: Record<string, unknown> = {};
  if (roles.leadId !== undefined) {
    if (roles.leadId !== null) {
      if (!isUuid(roles.leadId)) return { success: false, message: "Invalid lead id." };
      const eligible = await isEligibleRoleHolder(roles.leadId, project.groupId, "lead");
      if (!eligible.ok) return { success: false, message: eligible.reason ?? "Ineligible lead." };
    }
    patch.leadId = roles.leadId;
  }
  if (roles.qaId !== undefined) {
    if (roles.qaId !== null) {
      if (!isUuid(roles.qaId)) return { success: false, message: "Invalid QA id." };
      const eligible = await isEligibleRoleHolder(roles.qaId, project.groupId, "qa");
      if (!eligible.ok) return { success: false, message: eligible.reason ?? "Ineligible QA." };
    }
    patch.qaId = roles.qaId;
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, message: "No role changes provided." };
  }

  const facadeResult = await federatedWrite(
    {
      type: "setProjectRolesAction",
      actorId: userId,
      targetAgentId: project.groupId,
      payload: { projectId, ...patch },
    },
    async () => {
      const merged = { ...project.metadata, ...patch };
      if (project.home === "resource") {
        await db
          .update(resources)
          .set({ metadata: merged, updatedAt: new Date() })
          .where(eq(resources.id, projectId));
      } else {
        await db
          .update(agents)
          .set({ metadata: merged, updatedAt: new Date() })
          .where(eq(agents.id, projectId));
      }

      revalidatePath(`/projects/${projectId}`);
      revalidatePath(`/groups/${project.groupId}`);
      return { success: true, message: "Project roles updated." } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to update project roles." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: projectId,
    actorId: userId,
    payload: { action: "set_project_roles", ...patch },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Project roles updated." };
}
