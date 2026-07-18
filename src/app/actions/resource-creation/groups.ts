"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewAgent,
  type NewLedgerEntry,
  type NewResource,
  type VisibilityLevel,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { embedAgent, scheduleEmbedding } from "@/lib/ai";
import { ensureGroupMatrixRoom } from "@/lib/matrix-groups";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { type GroupJoinSettings } from "@/lib/types";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { hasCapability } from "@/lib/entitlements-server";
import { isOrganizationGroupType } from "@/lib/entitlements";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
} from "./helpers";
import { isGroupMember } from "@/lib/permissions";
import {
  DEFAULT_BALLOT_STYLE,
  ballotFromStored,
  isBallotStyle,
  resolveCreditsPerVoter,
  resolveScoreMax,
  tallyBallots,
  validateBallot,
  type Ballot,
  type PollBallotConfig,
} from "@/lib/governance-ballot";
import type { ActionResult, UpdateGroupResourceInput } from "./types";
import { desc } from "drizzle-orm";

const MAX_GROUP_DESCRIPTION_LENGTH = 50000;

export async function createGroupResource(input: {
  name: string;
  description: string;
  groupType: string;
  legalWrapper?: string;
  chapter: string;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  parentGroupId?: string | null;
  joinSettings?: GroupJoinSettings;
  groupPassword?: string | null;
  features?: { name: string; description: string }[];
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
}): Promise<ActionResult> {
  if (!input.name?.trim() || !input.description?.trim() || !input.groupType || !input.chapter) {
    return {
      success: false,
      message: "Please fill in all required group fields",
      error: {
        code: "INVALID_INPUT",
      },
    };
  }

  if (input.description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description exceeds maximum length of ${MAX_GROUP_DESCRIPTION_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  // Organization-type groups are gated by the create_org_group capability
  // (Organization / Steward / Worker). Community, family, and ring groups are
  // free for any signed-in user. A subgroup of an org still requires the caller
  // to hold write access on that org (checked below), so the org's own admins
  // can nest structure without re-buying the tier.
  if (isOrganizationGroupType(input.groupType) && !input.parentGroupId) {
    const canCreateOrg = await hasCapability(userId, "create_org_group");
    if (!canCreateOrg) {
      return {
        success: false,
        message: "Creating an organization requires an Organization membership.",
        error: {
          code: "SUBSCRIPTION_REQUIRED",
          details:
            "Subscribe to Organization to create organization-type groups. Community, family, and ring groups are free.",
          requiredTier: "organizer",
        },
      };
    }
  }

  // Authority for creating a group lives where the group will be homed: a
  // subgroup homes with its parent group, so route on the parent — routing on
  // the CREATOR forwarded sovereign-group subgroup creation to a remote-homed
  // admin's own home instance, which rejected it ("Federation mutations
  // require an actor-bound session or remote viewer token", 2026-07-11
  // persona simulation). Top-level creation stays actor-routed: the new group
  // homes wherever its creator is.
  const facadeResult = await updateFacade.execute(
    {
      type: "createGroupResource",
      actorId: userId,
      targetAgentId: input.parentGroupId ?? userId,
      payload: {},
    },
    async () => {
  try {
    if (input.parentGroupId) {
      // Subgroup creation is restricted to users with write permission on the parent group.
      const canWriteToParent = await hasGroupWriteAccess(userId, input.parentGroupId);
      if (!canWriteToParent) {
        return {
          success: false,
          message: "You do not have permission to create a subgroup here.",
          error: { code: "FORBIDDEN" },
        };
      }
    }

    // Dedicated group bucket protects org-creation endpoints from spam.
    const check = await rateLimit(`groups:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
    if (!check.success) {
      return {
        success: false,
        message: "Rate limit exceeded. Please try again later.",
        error: { code: "RATE_LIMITED" },
      };
    }

    const scopedLocaleIds = Array.from(
      new Set(
        [
          ...(Array.isArray(input.scopedLocaleIds) ? input.scopedLocaleIds : []),
          ...(input.chapter && input.chapter !== "all" ? [input.chapter] : []),
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0 && value !== "all")
      )
    );
    const scopedGroupIds = Array.from(
      new Set((input.scopedGroupIds ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0))
    );
    const scopedUserIds = Array.from(
      new Set((input.scopedUserIds ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0))
    );
    const wantsGlobal = input.isGlobal !== false;
    const hasScopedLocales = scopedLocaleIds.length > 0;
    const hasScopedGroupsOrUsers = scopedGroupIds.length > 0 || scopedUserIds.length > 0;
    let groupVisibility: VisibilityLevel = "public";
    if (!wantsGlobal) {
      groupVisibility = hasScopedLocales ? "locale" : "private";
    } else if (hasScopedLocales || hasScopedGroupsOrUsers) {
      groupVisibility = "locale";
    }
    const normalizedJoinSettings: GroupJoinSettings | undefined = input.joinSettings
      ? {
          joinType: input.joinSettings.joinType,
          visibility: input.joinSettings.visibility === "hidden" ? "hidden" : "public",
          questions: Array.isArray(input.joinSettings.questions) ? input.joinSettings.questions : [],
          approvalRequired: Boolean(input.joinSettings.approvalRequired),
          passwordRequired: Boolean(input.joinSettings.passwordRequired),
          inviteLink:
            typeof input.joinSettings.inviteLink === "string" && input.joinSettings.inviteLink.trim().length > 0
              ? input.joinSettings.inviteLink.trim()
              : undefined,
          applicationInstructions:
            typeof input.joinSettings.applicationInstructions === "string" &&
            input.joinSettings.applicationInstructions.trim().length > 0
              ? input.joinSettings.applicationInstructions.trim()
              : undefined,
        }
      : undefined;
    const normalizedGroupPassword =
      typeof input.groupPassword === "string" && input.groupPassword.trim().length >= 8
        ? input.groupPassword.trim()
        : null;
    const passwordHash = normalizedGroupPassword ? await hash(normalizedGroupPassword, 12) : null;
    const scopeTags = Array.from(new Set([...scopedLocaleIds, ...scopedGroupIds, ...scopedUserIds]));
    if (normalizedJoinSettings?.visibility === "hidden") {
      groupVisibility = "private";
    }

    const created = await db.transaction(async (tx) => {
      let parentDepth = 0;
      let parentPathIds: string[] = [];
      // A subgroup of an organization is itself org-grade: it inherits the full
      // org capability set (jobs, treasury, governance, badges, stake, mart, …)
      // rather than the basic tab set. Default to the requested type otherwise.
      let resolvedGroupType = input.groupType;
      if (input.parentGroupId) {
        // Parent depth/path are inherited to preserve hierarchy traversal efficiency.
        const parent = await tx.query.agents.findFirst({
          where: (a, { eq }) => eq(a.id, input.parentGroupId!),
          columns: { id: true, depth: true, pathIds: true, metadata: true },
        });
        if (parent) {
          parentDepth = parent.depth;
          parentPathIds = parent.pathIds ?? [];
          const parentMeta = (parent.metadata ?? {}) as Record<string, unknown>;
          const parentType = String(parentMeta.groupType ?? "").toLowerCase();
          if (parentType === "organization" || parentType === "org") {
            resolvedGroupType = "organization";
          }
        }
      }

      const [group] = await tx
        .insert(agents)
        .values({
          name: input.name.trim(),
          type: "organization",
          description: input.description.trim(),
          visibility: groupVisibility,
          parentId: input.parentGroupId ?? null,
          depth: input.parentGroupId ? parentDepth + 1 : 0,
          pathIds: input.parentGroupId ? [...parentPathIds, input.parentGroupId] : [],
          groupPasswordHash: passwordHash,
          metadata: {
            groupType: resolvedGroupType,
            legalWrapper: input.legalWrapper ?? null,
            chapter: input.chapter,
            chapterTags: scopedLocaleIds,
            parentGroupId: input.parentGroupId ?? null,
            features: input.features ?? [],
            creatorId: userId,
            joinSettings: normalizedJoinSettings,
            scopedLocaleIds,
            scopedGroupIds,
            scopedUserIds,
            isGlobal: wantsGlobal,
            scopeTags,
            ...(input.eftValues ? { eftValues: input.eftValues } : {}),
            ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
            ...(input.auditValues ? { auditValues: input.auditValues } : {}),
          },
        } as NewAgent)
        .returning({ id: agents.id });

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: group.id,
        objectType: "agent",
        metadata: {
          source: "create-page",
          entityType: "group",
          groupType: input.groupType,
        },
      } as NewLedgerEntry);

      await tx.insert(ledger).values({
        verb: "belong",
        subjectId: userId,
        objectId: group.id,
        objectType: "agent",
        isActive: true,
        role: "admin",
        metadata: {
          source: "create-page",
          interactionType: "membership",
          targetId: group.id,
          targetType: "group",
          grantedBy: userId,
          autoGrantedForCreator: true,
        },
      } as NewLedgerEntry);

      return group;
    });

    const grantEntries = [
      ...scopedGroupIds.map((subjectId) => ({ subjectId })),
      ...scopedUserIds.map((subjectId) => ({ subjectId })),
    ];
    if (grantEntries.length > 0) {
      try {
        await db.insert(ledger).values(
          grantEntries.map((entry) => ({
            verb: "grant" as const,
            subjectId: entry.subjectId,
            objectId: created.id,
            objectType: "agent" as const,
            isActive: true,
            metadata: { action: "view", source: "visibility-scope" },
          } as NewLedgerEntry))
        );
      } catch (error) {
        console.error("[createGroupResource] grant creation failed:", error);
      }
    }

    revalidatePath("/");
    revalidatePath("/groups");
    revalidatePath("/create");

    // Fire-and-forget: generate semantic embedding for the new group agent.
    scheduleEmbedding(() =>
      embedAgent(created.id, input.name, input.description)
    );
    void syncMurmurationsProfilesForActor(userId).catch((error) => {
      console.error("[murmurations] createGroupResource sync failed:", error);
    });

    // Fire-and-forget: every new group always gets a Matrix room.
    // ensureGroupMatrixRoom resolves the creator/admin and lazily provisions
    // their Matrix account if needed, so a creator without a Matrix identity no
    // longer blocks room creation (C1).
    (async () => {
      try {
        await ensureGroupMatrixRoom(created.id);
      } catch (err) {
        console.error("[createGroupResource] Matrix room creation failed:", err);
      }
    })();

    return {
      success: true,
      message: "Created successfully",
      resourceId: created.id,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to create group",
      error: {
        code: "SERVER_ERROR",
      },
    };
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success && data.resourceId) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_CREATED,
        entityType: "agent",
        entityId: data.resourceId,
        actorId: userId,
        payload: { name: input.name },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create group",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function updateGroupResource(input: UpdateGroupResourceInput): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to update content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (!input.groupId?.trim()) {
    return {
      success: false,
      message: "groupId is required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupResource",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to update this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const check = await rateLimit(`groups-update:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
    .limit(1);

  if (!group) {
    return {
      success: false,
      message: "Group not found.",
      error: { code: "NOT_FOUND" },
    };
  }

  const existingMetadata = group.metadata && typeof group.metadata === "object"
    ? (group.metadata as Record<string, unknown>)
    : {};
  const mergedMetadata = {
    ...existingMetadata,
    ...(input.metadataPatch ?? {}),
  };

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({
        name: typeof input.name === "string" ? input.name.trim() : undefined,
        description: typeof input.description === "string" ? input.description.trim() : undefined,
        metadata: input.metadataPatch ? mergedMetadata : undefined,
      })
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

    await tx.insert(ledger).values({
      verb: "update",
      subjectId: userId,
      objectId: input.groupId,
      objectType: "agent",
      metadata: { source: "update-group-action" },
    } as NewLedgerEntry);
  });

  revalidatePath("/");
  revalidatePath("/groups");
  revalidatePath(`/groups/${input.groupId}`);

  return {
    success: true,
    message: "Updated successfully",
    resourceId: input.groupId,
  } as ActionResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_UPDATED,
        entityType: "agent",
        entityId: input.groupId,
        actorId: userId,
        payload: { name: input.name },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to update group",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function deleteGroupResource(groupId: string): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to delete content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (!groupId?.trim()) {
    return {
      success: false,
      message: "groupId is required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "deleteGroupResource",
      actorId: userId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to delete this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const check = await rateLimit(`groups-delete:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  const [existingGroup] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
    .limit(1);

  if (!existingGroup) {
    return {
      success: false,
      message: "Group not found.",
      error: { code: "NOT_FOUND" },
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ deletedAt: new Date() })
      .where(and(eq(agents.id, groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

    await tx.insert(ledger).values({
      verb: "delete",
      subjectId: userId,
      objectId: groupId,
      objectType: "agent",
      metadata: { source: "delete-group-action" },
    } as NewLedgerEntry);
  });

  revalidatePath("/");
  revalidatePath("/groups");
  revalidatePath(`/groups/${groupId}`);

  return {
    success: true,
    message: "Deleted successfully",
    resourceId: groupId,
  } as ActionResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.AGENT_DELETED,
        entityType: "agent",
        entityId: groupId,
        actorId: userId,
        payload: {},
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to delete group",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function removeGroupRelationshipAction(input: {
  relationshipType: "subgroup" | "affiliated";
  parentGroupId: string;
  childGroupId: string;
}): Promise<ActionResult> {
  const { relationshipType, parentGroupId, childGroupId } = input;

  if (!parentGroupId?.trim() || !childGroupId?.trim()) {
    return {
      success: false,
      message: "parentGroupId and childGroupId are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to manage group relationships",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "removeGroupRelationship",
      actorId: userId,
      targetAgentId: parentGroupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, parentGroupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to manage relationships for this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const check = await rateLimit(`groups-update:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  try {
    if (relationshipType === "subgroup") {
      // Detach the child group from the parent by clearing its parent reference and flattening its path.
      const [child] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(and(eq(agents.id, childGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
        .limit(1);

      if (!child) {
        return { success: false, message: "Subgroup not found.", error: { code: "NOT_FOUND" } };
      }

      const childMeta = child.metadata && typeof child.metadata === "object"
        ? (child.metadata as Record<string, unknown>)
        : {};
      const updatedMeta = { ...childMeta, parentGroupId: null };

      await db.transaction(async (tx) => {
        await tx
          .update(agents)
          .set({ parentId: null, depth: 0, pathIds: [], metadata: updatedMeta, updatedAt: new Date() })
          .where(and(eq(agents.id, childGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

        await tx.insert(ledger).values({
          verb: "update",
          subjectId: userId,
          objectId: parentGroupId,
          objectType: "agent",
          metadata: {
            source: "remove-group-relationship",
            relationshipType: "subgroup",
            removedChildGroupId: childGroupId,
          },
        } as NewLedgerEntry);
      });
    } else {
      // Remove the affiliated group ID from the parent's affiliatedGroups metadata array.
      const [parent] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(and(eq(agents.id, parentGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
        .limit(1);

      if (!parent) {
        return { success: false, message: "Group not found.", error: { code: "NOT_FOUND" } };
      }

      const parentMeta = parent.metadata && typeof parent.metadata === "object"
        ? (parent.metadata as Record<string, unknown>)
        : {};
      const existingAffiliations = Array.isArray(parentMeta.affiliatedGroups)
        ? (parentMeta.affiliatedGroups as string[])
        : [];
      const updatedAffiliations = existingAffiliations.filter((id) => id !== childGroupId);
      const updatedMeta = { ...parentMeta, affiliatedGroups: updatedAffiliations };

      await db.transaction(async (tx) => {
        await tx
          .update(agents)
          .set({ metadata: updatedMeta, updatedAt: new Date() })
          .where(and(eq(agents.id, parentGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

        await tx.insert(ledger).values({
          verb: "update",
          subjectId: userId,
          objectId: parentGroupId,
          objectType: "agent",
          metadata: {
            source: "remove-group-relationship",
            relationshipType: "affiliated",
            removedAffiliatedGroupId: childGroupId,
          },
        } as NewLedgerEntry);
      });
    }

    revalidatePath("/groups");
    revalidatePath(`/groups/${parentGroupId}`);
    revalidatePath(`/groups/${childGroupId}`);

    return { success: true, message: "Relationship removed successfully" } as ActionResult;
  } catch (error) {
    console.error("[removeGroupRelationshipAction] failed:", error);
    return {
      success: false,
      message: "Failed to remove relationship",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_UPDATED,
        entityType: "agent",
        entityId: parentGroupId,
        actorId: userId,
        payload: { relationshipType, childGroupId },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to remove relationship",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

/**
 * Adds a LATERAL affiliation between two groups by appending `childGroupId` to
 * the parent group's `metadata.affiliatedGroups` array — the exact inverse of
 * {@link removeGroupRelationshipAction}'s affiliated branch. This is the real
 * write path behind the group About tab's "Add Relationship" control, which was
 * previously a client-side `alert()` stub (no persistence).
 *
 * Subgroup (parent-child) creation is intentionally NOT handled here — that has
 * its own flow (Create Subgroup / group-create with a parentId). Passing
 * `relationshipType: "subgroup"` returns a directive error rather than silently
 * re-homing a group.
 *
 * Owner-routed via updateFacade, gated by hasGroupWriteAccess + rate limit,
 * mirroring the remove action so authority is derived server-side only.
 */
export async function addGroupRelationshipAction(input: {
  relationshipType: "subgroup" | "affiliated";
  parentGroupId: string;
  childGroupId: string;
}): Promise<ActionResult> {
  const { relationshipType, parentGroupId, childGroupId } = input;

  if (!parentGroupId?.trim() || !childGroupId?.trim()) {
    return { success: false, message: "parentGroupId and childGroupId are required", error: { code: "INVALID_INPUT" } };
  }
  if (parentGroupId === childGroupId) {
    return { success: false, message: "A group cannot be affiliated with itself.", error: { code: "INVALID_INPUT" } };
  }
  if (relationshipType === "subgroup") {
    return { success: false, message: "Use Create Subgroup to nest a group; this control creates lateral affiliations.", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to manage group relationships", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "addGroupRelationship",
      actorId: userId,
      targetAgentId: parentGroupId,
      payload: input,
    },
    async () => {
      const canWrite = await hasGroupWriteAccess(userId, parentGroupId);
      if (!canWrite) {
        return { success: false, message: "You do not have permission to manage relationships for this group.", error: { code: "FORBIDDEN" } };
      }

      const check = await rateLimit(`groups-update:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
      if (!check.success) {
        return { success: false, message: "Rate limit exceeded. Please try again later.", error: { code: "RATE_LIMITED" } };
      }

      try {
        // The affiliated target must be a real, live group.
        const [child] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, childGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
          .limit(1);
        if (!child) {
          return { success: false, message: "The group you tried to affiliate was not found.", error: { code: "NOT_FOUND" } };
        }

        const [parent] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(and(eq(agents.id, parentGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
          .limit(1);
        if (!parent) {
          return { success: false, message: "Group not found.", error: { code: "NOT_FOUND" } };
        }

        const parentMeta = parent.metadata && typeof parent.metadata === "object"
          ? (parent.metadata as Record<string, unknown>)
          : {};
        const existingAffiliations = Array.isArray(parentMeta.affiliatedGroups)
          ? (parentMeta.affiliatedGroups as string[])
          : [];
        if (existingAffiliations.includes(childGroupId)) {
          return { success: true, message: "These groups are already affiliated." } as ActionResult;
        }
        const updatedMeta = { ...parentMeta, affiliatedGroups: [...existingAffiliations, childGroupId] };

        await db.transaction(async (tx) => {
          await tx
            .update(agents)
            .set({ metadata: updatedMeta, updatedAt: new Date() })
            .where(and(eq(agents.id, parentGroupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

          await tx.insert(ledger).values({
            verb: "update",
            subjectId: userId,
            objectId: parentGroupId,
            objectType: "agent",
            metadata: {
              source: "add-group-relationship",
              relationshipType: "affiliated",
              addedAffiliatedGroupId: childGroupId,
            },
          } as NewLedgerEntry);
        });

        revalidatePath("/groups");
        revalidatePath(`/groups/${parentGroupId}`);
        revalidatePath(`/groups/${childGroupId}`);
        return { success: true, message: "Affiliation created successfully" } as ActionResult;
      } catch (error) {
        console.error("[addGroupRelationshipAction] failed:", error);
        return { success: false, message: "Failed to create affiliation", error: { code: "SERVER_ERROR" } } as ActionResult;
      }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_UPDATED,
        entityType: "agent",
        entityId: parentGroupId,
        actorId: userId,
        payload: { relationshipType, childGroupId, action: "add" },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create affiliation",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

/** Resolve a stored poll item's ballot configuration (defaulting legacy polls
 *  to multiple-choice). Shared by cast + read paths. */
function pollConfigFromItem(item: Record<string, unknown>): PollBallotConfig {
  const ballotStyle = isBallotStyle(item.ballotStyle) ? item.ballotStyle : DEFAULT_BALLOT_STYLE;
  const config: PollBallotConfig = { ballotStyle };
  if (typeof item.scoreMax === "number") config.scoreMax = item.scoreMax;
  if (typeof item.creditsPerVoter === "number") config.creditsPerVoter = item.creditsPerVoter;
  return config;
}

export async function castGovernanceVoteAction(input: {
  groupId: string;
  targetId: string;
  targetType: "poll" | "proposal";
  /** Proposals: "yes"|"no"|"abstain". Multiple-choice polls: the option id.
   *  Other poll ballot styles send `ballot` instead. */
  vote?: string;
  /** P1 ballot styles (approval/score/ranked/rate-rank/quadratic) send a raw
   *  ballot payload validated against the poll's style; see `governance-ballot`. */
  ballot?: unknown;
  comment?: string;
}): Promise<ActionResult> {
  const hasBallot = input.ballot != null && typeof input.ballot === "object";
  if (!input.groupId?.trim() || !input.targetId?.trim() || (!input.vote?.trim() && !hasBallot)) {
    return {
      success: false,
      message: "groupId, targetId, and a vote or ballot are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to vote",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "castGovernanceVote",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  try {
    // P0 (members-only voting): a governance vote is a member act — only active
    // members of the owning group may vote. Being logged in is NOT sufficient
    // (parity with global's cast path).
    const membership = await isGroupMember(userId, input.groupId);
    if (!membership.isMember) {
      return {
        success: false,
        message: "You must be a group member to vote on this governance item.",
        error: { code: "FORBIDDEN" },
      };
    }

    // Load the group and locate the target item; a vote must reference a
    // poll/proposal that actually belongs to this group.
    const [groupRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
      .limit(1);

    if (!groupRow) {
      return { success: false, message: "Group not found", error: { code: "NOT_FOUND" } };
    }

    const groupMeta = groupRow.metadata && typeof groupRow.metadata === "object"
      ? (groupRow.metadata as Record<string, unknown>)
      : {};
    const metaKey = input.targetType === "poll" ? "polls" : "proposals";
    const items = Array.isArray(groupMeta[metaKey]) ? [...(groupMeta[metaKey] as Record<string, unknown>[])] : [];
    const idx = items.findIndex((item) => String(item.id) === input.targetId);
    if (idx < 0) {
      return {
        success: false,
        message: "Governance item does not belong to this group.",
        error: { code: "FORBIDDEN" },
      };
    }

    // P1 (ballot styles): for a poll, validate the incoming ballot against the
    // poll's configured style (multiple-choice is the legacy default and also
    // accepts the bare `vote` option id). Proposals stay yes/no/abstain.
    const pollConfig = input.targetType === "poll" ? pollConfigFromItem(items[idx]) : null;
    const pollOptionIds =
      input.targetType === "poll"
        ? (Array.isArray(items[idx].options) ? (items[idx].options as Record<string, unknown>[]) : []).map((o) => String(o.id))
        : [];
    let storedBallot: Ballot | null = null;
    if (input.targetType === "poll" && pollConfig) {
      const raw = hasBallot ? input.ballot : input.vote;
      const validated = validateBallot(pollConfig, pollOptionIds, raw);
      if (!validated.ok) {
        return { success: false, message: validated.error, error: { code: "INVALID_INPUT" } };
      }
      storedBallot = validated.ballot;
    }

    // Deactivate any prior vote by this user on the same governance item before inserting the new one.
    await db.execute(sql`
      UPDATE ledger
      SET is_active = false, expires_at = NOW()
      WHERE subject_id = ${userId}::uuid
        AND verb = 'vote'
        AND is_active = true
        AND metadata->>'targetId' = ${input.targetId}
        AND metadata->>'groupId' = ${input.groupId}
    `);

    await db.insert(ledger).values({
      verb: "vote",
      subjectId: userId,
      objectId: input.groupId,
      objectType: "agent",
      isActive: true,
      metadata: {
        groupId: input.groupId,
        targetId: input.targetId,
        targetType: input.targetType,
        // Proposals + multiple-choice keep the legacy scalar `vote`; richer poll
        // styles carry a normalized `ballot`.
        vote: storedBallot?.style === "multiple-choice" ? storedBallot.choice : (input.vote ?? null),
        ballot: storedBallot ?? null,
        comment: input.comment ?? null,
        interactionType: "governance-vote",
        votedAt: new Date().toISOString(),
      },
    } as NewLedgerEntry);

    // Tally write-back: the Governance tab renders vote counts from the group
    // agent's metadata, but votes persist ONLY to the ledger. Recompute the
    // authoritative tally from the ACTIVE governance-vote ledger rows and write
    // it back onto the item. Recomputing (rather than a per-cast increment) is
    // what makes a CHANGED vote correct: the prior row was deactivated above but
    // a naive increment would never decrement it, drifting on every re-vote.
    const activeVoteRows = await db
      .select({
        vote: sql<string>`${ledger.metadata}->>'vote'`,
        ballot: sql<unknown>`${ledger.metadata}->'ballot'`,
      })
      .from(ledger)
      .where(
        and(
          eq(ledger.verb, "vote"),
          eq(ledger.isActive, true),
          eq(ledger.objectId, input.groupId),
          sql`${ledger.metadata}->>'targetId' = ${input.targetId}`,
          sql`${ledger.metadata}->>'groupId' = ${input.groupId}`,
          sql`${ledger.metadata}->>'interactionType' = 'governance-vote'`,
        ),
      );

    const item = { ...items[idx] };
    if (input.targetType === "proposal") {
      const votes = { yes: 0, no: 0, abstain: 0 };
      for (const row of activeVoteRows) {
        const key = String(row.vote ?? "").toLowerCase();
        if (key === "yes" || key === "no" || key === "abstain") votes[key] += 1;
      }
      item.votes = votes;
    } else if (pollConfig) {
      // Recompute the per-style tally from every active ballot.
      const ballots: Ballot[] = [];
      for (const row of activeVoteRows) {
        const b = ballotFromStored(pollConfig.ballotStyle, row.ballot, row.vote);
        if (b) ballots.push(b);
      }
      const tally = tallyBallots(pollConfig, pollOptionIds, ballots);
      const byId = new Map(tally.options.map((o) => [o.id, o]));
      item.options = Array.isArray(item.options)
        ? (item.options as Record<string, unknown>[]).map((o) => ({
            ...o,
            votes: byId.get(String(o.id))?.value ?? 0,
          }))
        : [];
      item.totalVotes = tally.totalVotes;
      // Render model consumed by the governance tab (bars, labels, winner).
      item.tally = {
        style: tally.style,
        totalVotes: tally.totalVotes,
        winnerId: tally.winnerId ?? null,
        options: tally.options.map((o) => ({ id: o.id, value: o.value, fraction: o.fraction, label: o.label, count: o.count })),
      };
    }
    items[idx] = item;

    await db
      .update(agents)
      .set({ metadata: { ...groupMeta, [metaKey]: items }, updatedAt: new Date() })
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

    revalidatePath(`/groups/${input.groupId}`);

    return { success: true, message: "Vote recorded successfully" } as ActionResult;
  } catch (error) {
    console.error("[castGovernanceVoteAction] failed:", error);
    return {
      success: false,
      message: "Failed to record vote",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to record vote",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function createGovernanceProposalAction(input: {
  groupId: string;
  title: string;
  description: string;
  threshold: number;
  duration: number;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.title?.trim() || !input.description?.trim()) {
    return {
      success: false,
      message: "groupId, title, and description are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (typeof input.threshold !== "number" || input.threshold < 1 || input.threshold > 100) {
    return {
      success: false,
      message: "Threshold must be between 1 and 100",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (typeof input.duration !== "number" || input.duration < 1) {
    return {
      success: false,
      message: "Duration must be at least 1 day",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create proposals",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "createGovernanceProposal",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create proposals for this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  try {
    const [group] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
      .limit(1);

    if (!group) {
      return { success: false, message: "Group not found.", error: { code: "NOT_FOUND" } };
    }

    const groupMeta = group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
    const existingProposals = Array.isArray(groupMeta.proposals)
      ? (groupMeta.proposals as unknown[])
      : [];

    const endDate = new Date(Date.now() + input.duration * 24 * 60 * 60 * 1000);
    const proposalId = `proposal-${Date.now()}-${userId.slice(0, 8)}`;

    const newProposal = {
      id: proposalId,
      title: input.title.trim(),
      description: input.description.trim(),
      threshold: input.threshold,
      duration: input.duration,
      status: "active",
      endDate: endDate.toISOString(),
      createdAt: new Date().toISOString(),
      creatorId: userId,
      votes: { yes: 0, no: 0, abstain: 0 },
      comments: 0,
    };

    const updatedMeta = {
      ...groupMeta,
      proposals: [...existingProposals, newProposal],
    };

    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ metadata: updatedMeta, updatedAt: new Date() })
        .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: input.groupId,
        objectType: "agent",
        isActive: true,
        metadata: {
          source: "governance-tab",
          entityType: "proposal",
          proposalId,
          groupId: input.groupId,
          title: input.title.trim(),
        },
      } as NewLedgerEntry);
    });

    revalidatePath(`/groups/${input.groupId}`);
    revalidatePath(`/rings/${input.groupId}`);
    revalidatePath(`/families/${input.groupId}`);

    return {
      success: true,
      message: "Proposal created successfully",
      resourceId: proposalId,
    } as ActionResult;
  } catch (error) {
    console.error("[createGovernanceProposalAction] failed:", error);
    return {
      success: false,
      message: "Failed to create proposal",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.RESOURCE_CREATED,
        entityType: "agent",
        entityId: input.groupId,
        actorId: userId,
        payload: { title: input.title, proposalId: data.resourceId },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create proposal",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

/**
 * Creates a governance poll for a group (a lightweight multi-option vote,
 * distinct from a yes/no/abstain Proposal). The poll is appended to the group
 * agent's `metadata.polls` array — the same read path the Governance tab renders
 * (`group-tabs-client` → `governancePolls` → `GovernanceTab`) and that
 * `castGovernanceVoteAction` votes against (`targetType: "poll"`).
 *
 * Authority mirrors {@link createGovernanceProposalAction}: authenticated +
 * group write access (`hasGroupWriteAccess`, cascades to parent-group admins).
 * Requires at least two non-empty options.
 */
export async function createGovernancePollAction(input: {
  groupId: string;
  question: string;
  description?: string;
  options: string[];
  duration: number;
  /** P1 ballot style (defaults to multiple-choice). */
  ballotStyle?: string;
  /** score/rate-rank slider max. */
  scoreMax?: number;
  /** quadratic per-voter credit budget. */
  creditsPerVoter?: number;
}): Promise<ActionResult> {
  const cleanedOptions = Array.isArray(input.options)
    ? input.options.map((o) => (typeof o === "string" ? o.trim() : "")).filter((o) => o.length > 0)
    : [];
  const ballotStyle = isBallotStyle(input.ballotStyle) ? input.ballotStyle : DEFAULT_BALLOT_STYLE;

  if (!input.groupId?.trim() || !input.question?.trim()) {
    return {
      success: false,
      message: "groupId and question are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (cleanedOptions.length < 2) {
    return {
      success: false,
      message: "A poll requires at least two options",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (typeof input.duration !== "number" || input.duration < 1) {
    return {
      success: false,
      message: "Duration must be at least 1 day",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create polls",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "createGovernancePoll",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create polls for this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  try {
    const [group] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
      .limit(1);

    if (!group) {
      return { success: false, message: "Group not found.", error: { code: "NOT_FOUND" } };
    }

    const groupMeta = group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
    const existingPolls = Array.isArray(groupMeta.polls)
      ? (groupMeta.polls as unknown[])
      : [];

    const endDate = new Date(Date.now() + input.duration * 24 * 60 * 60 * 1000);
    const pollId = `poll-${Date.now()}-${userId.slice(0, 8)}`;

    const pollConfig: PollBallotConfig = { ballotStyle };
    if (ballotStyle === "score" || ballotStyle === "rate-rank") {
      pollConfig.scoreMax = resolveScoreMax({ ballotStyle, scoreMax: input.scoreMax });
    }
    if (ballotStyle === "quadratic") {
      pollConfig.creditsPerVoter = resolveCreditsPerVoter({ ballotStyle, creditsPerVoter: input.creditsPerVoter });
    }

    const newPoll = {
      id: pollId,
      question: input.question.trim(),
      description: input.description?.trim() || "",
      options: cleanedOptions.map((text, idx) => ({
        id: `${pollId}-opt-${idx}`,
        text,
        votes: 0,
      })),
      totalVotes: 0,
      duration: input.duration,
      status: "active",
      // P1 ballot-style config (multiple-choice omits the extra fields).
      ballotStyle,
      ...(pollConfig.scoreMax != null ? { scoreMax: pollConfig.scoreMax } : {}),
      ...(pollConfig.creditsPerVoter != null ? { creditsPerVoter: pollConfig.creditsPerVoter } : {}),
      endDate: endDate.toISOString(),
      createdAt: new Date().toISOString(),
      creatorId: userId,
    };

    const updatedMeta = {
      ...groupMeta,
      polls: [...existingPolls, newPoll],
    };

    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ metadata: updatedMeta, updatedAt: new Date() })
        .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: input.groupId,
        objectType: "agent",
        isActive: true,
        metadata: {
          source: "governance-tab",
          entityType: "poll",
          pollId,
          groupId: input.groupId,
          question: input.question.trim(),
        },
      } as NewLedgerEntry);
    });

    revalidatePath(`/groups/${input.groupId}`);
    revalidatePath(`/rings/${input.groupId}`);
    revalidatePath(`/families/${input.groupId}`);

    return {
      success: true,
      message: "Poll created successfully",
      resourceId: pollId,
    } as ActionResult;
  } catch (error) {
    console.error("[createGovernancePollAction] failed:", error);
    return {
      success: false,
      message: "Failed to create poll",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.RESOURCE_CREATED,
        entityType: "agent",
        entityId: input.groupId,
        actorId: userId,
        payload: { question: input.question, pollId: data.resourceId },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create poll",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function createGovernanceIssueAction(input: {
  groupId: string;
  title: string;
  description: string;
  tags?: string[];
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.title?.trim() || !input.description?.trim()) {
    return {
      success: false,
      message: "groupId, title, and description are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create issues",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "createGovernanceIssue",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create issues for this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  try {
    const [group] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`))
      .limit(1);

    if (!group) {
      return { success: false, message: "Group not found.", error: { code: "NOT_FOUND" } };
    }

    const groupMeta = group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
    const existingIssues = Array.isArray(groupMeta.issues)
      ? (groupMeta.issues as unknown[])
      : [];
    const issueId = `issue-${Date.now()}-${userId.slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const newIssue = {
      id: issueId,
      type: "issue",
      title: input.title.trim(),
      description: input.description.trim(),
      status: "open",
      creatorId: userId,
      creatorName: null,
      createdAt: nowIso,
      tags: input.tags ?? [],
      votesUp: 0,
      votesDown: 0,
      comments: 0,
    };

    const updatedMeta = {
      ...groupMeta,
      issues: [...existingIssues, newIssue],
    };

    await db.transaction(async (tx) => {
      const [creator] = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, userId))
        .limit(1);

      await tx
        .update(agents)
        .set({
          metadata: {
            ...groupMeta,
            issues: [...existingIssues, { ...newIssue, creatorName: creator?.name ?? null }],
          },
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, input.groupId), eq(agents.type, "organization"), sql`${agents.deletedAt} IS NULL`));

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: input.groupId,
        objectType: "agent",
        isActive: true,
        metadata: {
          source: "governance-tab",
          entityType: "issue",
          issueId,
          groupId: input.groupId,
          title: input.title.trim(),
        },
      } as NewLedgerEntry);
    });

    revalidatePath(`/groups/${input.groupId}`);
    revalidatePath(`/rings/${input.groupId}`);
    revalidatePath(`/families/${input.groupId}`);

    return {
      success: true,
      message: "Issue created successfully",
      resourceId: issueId,
    } as ActionResult;
  } catch (error) {
    console.error("[createGovernanceIssueAction] failed:", error);
    return {
      success: false,
      message: "Failed to create issue",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.RESOURCE_CREATED,
        entityType: "agent",
        entityId: input.groupId,
        actorId: userId,
        payload: { title: input.title, issueId: data.resourceId },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create issue",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

// ─── Governance Badge Actions ─────────────────────────────────────────────────

export async function fetchGovernanceBadgesAction(
  groupId: string,
): Promise<ActionResult & { badges?: Array<Record<string, unknown>> }> {
  if (!groupId?.trim()) {
    return { success: false, message: "groupId is required", error: { code: "INVALID_INPUT" } };
  }

  try {
    const rows = await db
      .select({
        id: resources.id,
        name: resources.name,
        description: resources.description,
        metadata: resources.metadata,
        createdAt: resources.createdAt,
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

    return {
      success: true,
      message: "Governance badges fetched",
      badges: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        metadata: r.metadata,
        createdAt: r.createdAt?.toISOString() ?? null,
      })),
    };
  } catch (error) {
    console.error("[fetchGovernanceBadgesAction] failed:", error);
    return { success: false, message: "Failed to fetch governance badges", error: { code: "SERVER_ERROR" } };
  }
}

export async function checkGovernanceBadgeHolderAction(
  groupId: string,
): Promise<ActionResult & { isHolder?: boolean; heldBadgeIds?: string[] }> {
  if (!groupId?.trim()) {
    return { success: false, message: "groupId is required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  try {
    // Find all governance badges for this group
    const badges = await db
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, groupId),
          eq(resources.type, "badge"),
          sql`${resources.metadata}->>'badgeType' = 'governance'`,
          sql`${resources.deletedAt} IS NULL`,
        ),
      );

    if (badges.length === 0) {
      return { success: true, message: "No governance badges exist", isHolder: false, heldBadgeIds: [] };
    }

    const badgeIds = badges.map((b) => b.id);

    // Check if user has active 'assign' ledger entries for any of these badges
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

    const heldBadgeIds = assignments.map((a) => a.objectId).filter((id): id is string => id !== null);

    return {
      success: true,
      message: heldBadgeIds.length > 0 ? "User holds governance badges" : "User does not hold governance badges",
      isHolder: heldBadgeIds.length > 0,
      heldBadgeIds,
    };
  } catch (error) {
    console.error("[checkGovernanceBadgeHolderAction] failed:", error);
    return { success: false, message: "Failed to check badge holder status", error: { code: "SERVER_ERROR" } };
  }
}

export async function createGovernanceBadgeAction(input: {
  groupId: string;
  name: string;
  description: string;
  votingWeight: number;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.name?.trim()) {
    return { success: false, message: "groupId and name are required", error: { code: "INVALID_INPUT" } };
  }

  if (typeof input.votingWeight !== "number" || input.votingWeight < 0) {
    return { success: false, message: "votingWeight must be a non-negative number", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "createGovernanceBadge",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, message: "Admin access required to create governance badges", error: { code: "FORBIDDEN" } };
  }

  try {
    const [badge] = await db
      .insert(resources)
      .values({
        name: input.name.trim(),
        description: (input.description ?? "").trim(),
        type: "badge",
        ownerId: input.groupId,
        metadata: {
          badgeType: "governance",
          votingWeight: input.votingWeight,
          creatorId: userId,
        },
      } as NewResource)
      .returning({ id: resources.id });

    await db.insert(ledger).values({
      verb: "create",
      subjectId: userId,
      objectId: badge.id,
      objectType: "resource",
      metadata: {
        source: "governance-badge",
        entityType: "badge",
        badgeType: "governance",
        groupId: input.groupId,
      },
    } as NewLedgerEntry);

    revalidatePath(`/groups/${input.groupId}`);

    return { success: true, message: "Governance badge created", resourceId: badge.id } as ActionResult;
  } catch (error) {
    console.error("[createGovernanceBadgeAction] failed:", error);
    return { success: false, message: "Failed to create governance badge", error: { code: "SERVER_ERROR" } } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as ActionResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.RESOURCE_CREATED,
        entityType: "resource",
        entityId: data.resourceId ?? input.groupId,
        actorId: userId,
        payload: { name: input.name, badgeType: "governance", groupId: input.groupId },
      }).catch(() => {});
    }
    return data;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to create governance badge",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function assignGovernanceBadgeAction(input: {
  badgeId: string;
  agentId: string;
  groupId: string;
}): Promise<ActionResult> {
  if (!input.badgeId?.trim() || !input.agentId?.trim() || !input.groupId?.trim()) {
    return { success: false, message: "badgeId, agentId, and groupId are required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "assignGovernanceBadge",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, message: "Admin access required to assign governance badges", error: { code: "FORBIDDEN" } };
  }

  try {
    await db.insert(ledger).values({
      verb: "assign",
      subjectId: input.agentId,
      objectId: input.badgeId,
      objectType: "resource",
      isActive: true,
      metadata: {
        source: "governance-badge-assign",
        groupId: input.groupId,
        assignedBy: userId,
        interactionType: "governance-badge-assignment",
      },
    } as NewLedgerEntry);

    revalidatePath(`/groups/${input.groupId}`);

    return { success: true, message: "Governance badge assigned" } as ActionResult;
  } catch (error) {
    console.error("[assignGovernanceBadgeAction] failed:", error);
    return { success: false, message: "Failed to assign governance badge", error: { code: "SERVER_ERROR" } } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to assign governance badge",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function revokeGovernanceBadgeAction(input: {
  badgeId: string;
  agentId: string;
  groupId: string;
}): Promise<ActionResult> {
  if (!input.badgeId?.trim() || !input.agentId?.trim() || !input.groupId?.trim()) {
    return { success: false, message: "badgeId, agentId, and groupId are required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "revokeGovernanceBadge",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, message: "Admin access required to revoke governance badges", error: { code: "FORBIDDEN" } };
  }

  try {
    // Deactivate the assignment ledger entry
    await db.execute(sql`
      UPDATE ledger
      SET is_active = false, expires_at = NOW()
      WHERE subject_id = ${input.agentId}::uuid
        AND object_id = ${input.badgeId}::uuid
        AND verb = 'assign'
        AND is_active = true
        AND metadata->>'interactionType' = 'governance-badge-assignment'
        AND metadata->>'groupId' = ${input.groupId}
    `);

    await db.insert(ledger).values({
      verb: "delete",
      subjectId: userId,
      objectId: input.badgeId,
      objectType: "resource",
      metadata: {
        source: "governance-badge-revoke",
        groupId: input.groupId,
        revokedAgentId: input.agentId,
        interactionType: "governance-badge-revocation",
      },
    } as NewLedgerEntry);

    revalidatePath(`/groups/${input.groupId}`);

    return { success: true, message: "Governance badge revoked" } as ActionResult;
  } catch (error) {
    console.error("[revokeGovernanceBadgeAction] failed:", error);
    return { success: false, message: "Failed to revoke governance badge", error: { code: "SERVER_ERROR" } } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to revoke governance badge",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function castBadgeGatedVoteAction(input: {
  proposalId: string;
  vote: string;
  badgeId: string;
  groupId: string;
}): Promise<ActionResult> {
  if (!input.proposalId?.trim() || !input.vote?.trim() || !input.badgeId?.trim() || !input.groupId?.trim()) {
    return { success: false, message: "proposalId, vote, badgeId, and groupId are required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to vote", error: { code: "UNAUTHENTICATED" } };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "castBadgeGatedVote",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: {},
    },
    async () => {
  try {
    // Verify the user holds this governance badge
    const [assignment] = await db
      .select({ id: ledger.id })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, userId),
          eq(ledger.objectId, input.badgeId),
          eq(ledger.verb, "assign"),
          eq(ledger.isActive, true),
          sql`${ledger.metadata}->>'interactionType' = 'governance-badge-assignment'`,
          sql`${ledger.metadata}->>'groupId' = ${input.groupId}`,
        ),
      )
      .limit(1);

    if (!assignment) {
      return { success: false, message: "You do not hold the required governance badge to vote", error: { code: "FORBIDDEN" } };
    }

    // Look up the badge's voting weight
    const [badge] = await db
      .select({ metadata: resources.metadata })
      .from(resources)
      .where(
        and(
          eq(resources.id, input.badgeId),
          eq(resources.type, "badge"),
          sql`${resources.deletedAt} IS NULL`,
        ),
      )
      .limit(1);

    const badgeMeta = badge?.metadata && typeof badge.metadata === "object"
      ? (badge.metadata as Record<string, unknown>)
      : {};
    const votingWeight = typeof badgeMeta.votingWeight === "number" ? badgeMeta.votingWeight : 1;

    // Deactivate any prior badge-gated vote by this user on this proposal
    await db.execute(sql`
      UPDATE ledger
      SET is_active = false, expires_at = NOW()
      WHERE subject_id = ${userId}::uuid
        AND verb = 'vote'
        AND is_active = true
        AND metadata->>'proposalId' = ${input.proposalId}
        AND metadata->>'interactionType' = 'badge-gated-vote'
        AND metadata->>'groupId' = ${input.groupId}
    `);

    await db.insert(ledger).values({
      verb: "vote",
      subjectId: userId,
      objectId: input.groupId,
      objectType: "agent",
      isActive: true,
      metadata: {
        interactionType: "badge-gated-vote",
        proposalId: input.proposalId,
        vote: input.vote,
        badgeId: input.badgeId,
        groupId: input.groupId,
        votingWeight,
        votedAt: new Date().toISOString(),
      },
    } as NewLedgerEntry);

    revalidatePath(`/groups/${input.groupId}`);

    return { success: true, message: "Badge-gated vote recorded" } as ActionResult;
  } catch (error) {
    console.error("[castBadgeGatedVoteAction] failed:", error);
    return { success: false, message: "Failed to cast badge-gated vote", error: { code: "SERVER_ERROR" } } as ActionResult;
  }
    }
  );

  if (facadeResult.success && facadeResult.data) {
    return facadeResult.data as ActionResult;
  }

  return {
    success: false,
    message: facadeResult.error ?? "Failed to cast badge-gated vote",
    error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
  };
}

export async function getProposalVotesAction(input: {
  proposalId: string;
  groupId: string;
}): Promise<ActionResult & { votes?: Array<Record<string, unknown>>; summary?: Record<string, number> }> {
  if (!input.proposalId?.trim() || !input.groupId?.trim()) {
    return { success: false, message: "proposalId and groupId are required", error: { code: "INVALID_INPUT" } };
  }

  try {
    const voteRows = await db
      .select({
        id: ledger.id,
        subjectId: ledger.subjectId,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
      })
      .from(ledger)
      .where(
        and(
          eq(ledger.verb, "vote"),
          eq(ledger.isActive, true),
          eq(ledger.objectId, input.groupId),
          sql`${ledger.metadata}->>'proposalId' = ${input.proposalId}`,
          sql`${ledger.metadata}->>'groupId' = ${input.groupId}`,
        ),
      )
      .orderBy(desc(ledger.timestamp));

    // Enrich with voter names
    const voterIds = [...new Set(voteRows.map((r) => r.subjectId))];
    const voterAgents =
      voterIds.length > 0
        ? await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, voterIds))
        : [];
    const voterMap = new Map(voterAgents.map((a) => [a.id, a.name]));

    // Build weighted summary
    const summary: Record<string, number> = {};
    const votes = voteRows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const vote = (meta.vote as string) ?? "unknown";
      const weight = typeof meta.votingWeight === "number" ? meta.votingWeight : 1;
      summary[vote] = (summary[vote] ?? 0) + weight;
      return {
        id: row.id,
        voterId: row.subjectId,
        voterName: voterMap.get(row.subjectId) ?? null,
        vote,
        votingWeight: weight,
        badgeId: meta.badgeId ?? null,
        interactionType: meta.interactionType ?? null,
        votedAt: row.timestamp?.toISOString() ?? null,
      };
    });

    return { success: true, message: "Proposal votes fetched", votes, summary };
  } catch (error) {
    console.error("[getProposalVotesAction] failed:", error);
    return { success: false, message: "Failed to fetch proposal votes", error: { code: "SERVER_ERROR" } };
  }
}
