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
import { and, eq, sql } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { embedAgent, scheduleEmbedding } from "@/lib/ai";
import { createGroupMatrixRoom } from "@/lib/matrix-groups";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { type GroupJoinSettings } from "@/lib/types";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
} from "./helpers";
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

  const facadeResult = await updateFacade.execute(
    {
      type: "createGroupResource",
      actorId: userId,
      targetAgentId: userId,
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
      if (input.parentGroupId) {
        // Parent depth/path are inherited to preserve hierarchy traversal efficiency.
        const parent = await tx.query.agents.findFirst({
          where: (a, { eq }) => eq(a.id, input.parentGroupId!),
          columns: { id: true, depth: true, pathIds: true },
        });
        if (parent) {
          parentDepth = parent.depth;
          parentPathIds = parent.pathIds ?? [];
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
            groupType: input.groupType,
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

    // Fire-and-forget: create a Matrix room for the group and join the creator.
    (async () => {
      try {
        const creator = await db.query.agents.findFirst({
          where: eq(agents.id, userId),
          columns: { matrixUserId: true },
        });
        if (creator?.matrixUserId) {
          await createGroupMatrixRoom({
            groupAgentId: created.id,
            groupName: input.name.trim(),
            creatorMatrixUserId: creator.matrixUserId,
          });
        }
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

export async function castGovernanceVoteAction(input: {
  groupId: string;
  targetId: string;
  targetType: "poll" | "proposal";
  vote: string;
  comment?: string;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.targetId?.trim() || !input.vote?.trim()) {
    return {
      success: false,
      message: "groupId, targetId, and vote are required",
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
        vote: input.vote,
        comment: input.comment ?? null,
        interactionType: "governance-vote",
        votedAt: new Date().toISOString(),
      },
    } as NewLedgerEntry);

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
          sql`${ledger.objectId} = ANY(${badgeIds})`,
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
            .where(sql`${agents.id} = ANY(${voterIds})`)
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
