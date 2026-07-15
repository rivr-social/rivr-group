"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewLedgerEntry,
  type NewResource,
  type VisibilityLevel,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { hasEntitlement } from "@/lib/billing";
import { embedResource, scheduleEmbedding } from "@/lib/ai";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
  canPostToGroup,
  canModifyResource,
  revalidateOwnerPaths,
  createResourceWithLedger,
} from "./helpers";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";
import { routeWrite } from "@/lib/federation/write-router";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { syncResourceToGoogle } from "@/lib/google/calendar-sync";
import type { ActionResult, UpdateResourceInput } from "./types";
import { normalizeEventTickets } from "./types";
import { syncEventTicketOfferings } from "./events";

export async function updateResource(input: UpdateResourceInput): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to update content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (!input.resourceId?.trim()) {
    return {
      success: false,
      message: "resourceId is required",
      error: { code: "INVALID_INPUT" },
    };
  }

  // Independent update bucket protects mutation endpoints from burst traffic.
  const check = await rateLimit(`resources-update:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  const permission = await canModifyResource(userId, input.resourceId);
  // Distinguish "does not exist" from "exists but you may not touch it": a
  // missing resource returns NOT_FOUND (canModifyResource omits `resource` only
  // when the row is absent/soft-deleted) so callers aren't told FORBIDDEN for an
  // id that never existed. Existence is checked before permission.
  if (!permission.resource) {
    return {
      success: false,
      message: "That object does not exist or has been deleted.",
      error: { code: "NOT_FOUND" },
    };
  }
  if (!permission.allowed) {
    return {
      success: false,
      message: "You do not have permission to update this object.",
      error: { code: "FORBIDDEN" },
    };
  }

  const existingMetadata =
    permission.resource.metadata && typeof permission.resource.metadata === "object"
      ? permission.resource.metadata
      : {};
  let nextOwnerId = permission.resource.ownerId;
  if (input.ownerId && input.ownerId !== permission.resource.ownerId) {
    if (input.ownerId === "self") {
      nextOwnerId = userId;
    } else if (input.ownerId !== userId) {
      const [targetOwner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.ownerId), eq(agents.type, "organization")))
        .limit(1);
      if (!targetOwner || !(await hasGroupWriteAccess(userId, input.ownerId))) {
        return {
          success: false,
          message: "You do not have permission to move this resource to that group.",
          error: { code: "FORBIDDEN" },
        };
      }
      nextOwnerId = input.ownerId;
    } else {
      nextOwnerId = input.ownerId;
    }
  }
  const mergedMetadata = {
    ...existingMetadata,
    ...(input.metadataPatch ?? {}),
  };

  // Capture the verified resource for use inside the facade closure (TypeScript narrowing doesn't cross async boundaries).
  const verifiedResource = permission.resource!;

  // Update + audit entry stay in one transaction so history matches state.
  const updateTargetAgentId = nextOwnerId;
  const updateFacadeResult = await updateFacade.execute(
    {
      type: "updateResource",
      actorId: userId,
      targetAgentId: updateTargetAgentId,
      payload: input,
    },
    async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({
            ownerId: nextOwnerId,
            name: typeof input.name === "string" ? input.name.trim() : undefined,
            description: input.description === undefined ? undefined : input.description,
            content: input.content === undefined ? undefined : input.content,
            tags: input.tags === undefined ? undefined : input.tags,
            visibility: input.visibility === undefined ? undefined : input.visibility,
            metadata: input.metadataPatch ? mergedMetadata : undefined,
          })
          .where(eq(resources.id, input.resourceId));

        await tx.insert(ledger).values({
          verb: "update",
          subjectId: userId,
          objectId: input.resourceId,
          objectType: "resource",
          resourceId: input.resourceId,
          metadata: {
            source: "update-resource-action",
          },
        } as NewLedgerEntry);
      });

      revalidatePath("/");
      revalidatePath(`/events/${input.resourceId}`);
      revalidatePath(`/posts/${input.resourceId}`);
      revalidatePath(`/marketplace/${input.resourceId}`);
      revalidatePath(`/projects/${input.resourceId}`);
      await revalidateOwnerPaths(verifiedResource.ownerId);
      if (nextOwnerId !== verifiedResource.ownerId) {
        await revalidateOwnerPaths(nextOwnerId);
      }

      // Re-embed when name or description changes so semantic search stays current.
      const updatedName = typeof input.name === "string" ? input.name.trim() : verifiedResource.name;
      const updatedDescription = input.description !== undefined ? input.description : verifiedResource.description;
      if (typeof input.name === "string" || input.description !== undefined) {
        scheduleEmbedding(() => embedResource(input.resourceId, updatedName, updatedDescription));
      }

      // Keep event ticket offerings in sync with the canonical event ticket metadata.
      const isEventResource = (verifiedResource.metadata as Record<string, unknown>)?.resourceKind === "event";
      const shouldSyncEventTickets =
        isEventResource &&
        (nextOwnerId !== verifiedResource.ownerId ||
          (!!input.metadataPatch &&
            (("price" in input.metadataPatch) ||
              ("ticketTypes" in input.metadataPatch) ||
              ("groupId" in input.metadataPatch) ||
              ("scopedLocaleIds" in input.metadataPatch) ||
              ("scopedGroupIds" in input.metadataPatch) ||
              ("scopedUserIds" in input.metadataPatch))));
      if (shouldSyncEventTickets) {
        try {
          const nextMetadata = {
            ...(verifiedResource.metadata ?? {}),
            ...(input.metadataPatch ?? {}),
          } as Record<string, unknown>;
          const ticketTypes = normalizeEventTickets({
            ticketTypes: Array.isArray(nextMetadata.ticketTypes) ? (nextMetadata.ticketTypes as Array<{ id?: string; name: string; description?: string | null; price?: number | null; quantity?: number | null }>) : undefined,
            price: typeof nextMetadata.price === "number" ? nextMetadata.price : Number(nextMetadata.price ?? 0),
          });
          const hasPaidTicket = ticketTypes.some((ticket) => ticket.priceCents > 0);

          // Gate paid tickets behind host membership - return error code so UI can prompt signup.
          if (hasPaidTicket) {
            const canSellTickets = await hasEntitlement(userId, "host");
            if (!canSellTickets) {
              return {
                success: true,
                message: "Event updated, but paid tickets require a Host membership or higher.",
                resourceId: input.resourceId,
                error: {
                  code: "SUBSCRIPTION_REQUIRED",
                  details: "Subscribe to Host (or higher) to sell event tickets.",
                  requiredTier: "host",
                },
              } as ActionResult;
            }
          }

          const eventName = updatedName;
          await syncEventTicketOfferings({
            eventId: input.resourceId,
            ownerId: nextOwnerId,
            eventName,
            eventDescription: typeof updatedDescription === "string" ? updatedDescription : "",
            visibility: (input.visibility ?? verifiedResource.visibility ?? "public") as VisibilityLevel,
            tags: input.tags ?? verifiedResource.tags ?? [],
            scopedLocaleIds: Array.isArray(nextMetadata.scopedLocaleIds) ? nextMetadata.scopedLocaleIds as string[] : [],
            scopedGroupIds: Array.isArray(nextMetadata.scopedGroupIds) ? nextMetadata.scopedGroupIds as string[] : [],
            scopedUserIds: Array.isArray(nextMetadata.scopedUserIds) ? nextMetadata.scopedUserIds as string[] : [],
            ticketTypes,
          });
        } catch (error) {
          console.error("[updateResource] companion offering sync failed:", error);
        }
      }

      // Best-effort outbound sync to Google Calendar for event resources
      // owned by a group. Failures are logged but never propagated — sync
      // must not block resource updates. Echo suppression and 412
      // last-write-wins are handled inside syncResourceToGoogle.
      if (isEventResource) {
        const candidateGroupId =
          (mergedMetadata as Record<string, unknown>).groupId;
        const groupIdForSync =
          typeof candidateGroupId === "string" && candidateGroupId.length > 0
            ? candidateGroupId
            : nextOwnerId !== userId
              ? nextOwnerId
              : null;
        if (groupIdForSync) {
          try {
            const outcome = await syncResourceToGoogle(input.resourceId, groupIdForSync);
            if (!outcome.ok) {
              console.error(
                `[updateResource] google calendar sync (${outcome.code}) for ${input.resourceId}: ${outcome.message ?? ""}`,
              );
            }
          } catch (error) {
            console.error("[updateResource] google calendar sync threw:", error);
          }
        }
      }

      return {
        success: true,
        message: "Updated successfully",
        resourceId: input.resourceId,
      } as ActionResult;
    },
  );

  if (!updateFacadeResult.success) {
    return {
      success: false,
      message: updateFacadeResult.error ?? "Failed to update resource",
      error: { code: updateFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const updateActionResult = updateFacadeResult.data as ActionResult;

  if (updateActionResult?.success) {
    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_UPDATED,
      entityType: "resource",
      entityId: input.resourceId,
      actorId: userId,
      payload: { resourceType: (verifiedResource.metadata as Record<string, unknown>)?.resourceKind ?? null },
    }).catch(() => {});
  }

  return updateActionResult;
}

export async function deleteResource(resourceId: string): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to delete content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (!resourceId?.trim()) {
    return {
      success: false,
      message: "resourceId is required",
      error: { code: "INVALID_INPUT" },
    };
  }

  // Separate delete key prevents abusive bulk removal traffic.
  const check = await rateLimit(`resources-delete:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  const permission = await canModifyResource(userId, resourceId);
  // Existence before permission (see updateResource): a missing id returns
  // NOT_FOUND rather than masking it as a permission denial.
  if (!permission.resource) {
    return {
      success: false,
      message: "That object does not exist or has been deleted.",
      error: { code: "NOT_FOUND" },
    };
  }
  if (!permission.allowed) {
    return {
      success: false,
      message: "You do not have permission to delete this object.",
      error: { code: "FORBIDDEN" },
    };
  }

  // Owner-routed cross-instance DELETE (mirror parity, 2026-07-06): when the
  // resource's owner is homed on a PEER instance, this local row is a federated
  // mirror - deleting only it would fork state from the authoritative home.
  // Forward the delete over the signed mutation rail; the home re-authorizes
  // the entity-map-normalized actor, soft-deletes, and emits RESOURCE_DELETED.
  // On confirmed success the local mirror is retired immediately so this
  // viewer's surfaces update without waiting for the returning event.
  const mirrorOwnerId = permission.resource.ownerId;
  const mirrorHome = await resolveHomeInstance(mirrorOwnerId).catch(() => null);
  if (mirrorHome && !mirrorHome.isLocal) {
    const mirrorMetadata = (permission.resource.metadata ?? null) as Record<string, unknown> | null;
    const homeResourceId =
      mirrorMetadata && typeof mirrorMetadata.externalEntityId === "string" && mirrorMetadata.externalEntityId.trim()
        ? mirrorMetadata.externalEntityId.trim()
        : resourceId;
    const routedDelete = await routeWrite<{ resourceId: string }, ActionResult>(
      {
        type: "deleteResource",
        actorId: userId,
        targetAgentId: mirrorOwnerId,
        payload: { resourceId: homeResourceId },
      },
      async () => {
        throw new Error("Mirror delete must not run the local executor");
      },
    );
    if (!routedDelete.success) {
      return {
        success: false,
        message: routedDelete.error ?? "Failed to delete resource on its home instance",
        error: { code: routedDelete.errorCode ?? "REMOTE_EXECUTION_FAILED" },
      };
    }
    await db.update(resources).set({ deletedAt: new Date() }).where(eq(resources.id, resourceId));
    return { success: true, message: "Deleted on its home instance", resourceId };
  }

  const verifiedDeleteResource = permission.resource!;
  const deleteTargetAgentId = verifiedDeleteResource.ownerId;
  const deleteFacadeResult = await updateFacade.execute(
    {
      type: "deleteResource",
      actorId: userId,
      targetAgentId: deleteTargetAgentId,
      payload: { resourceId },
    },
    async () => {
      const [hasReceiptHistory] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.type, "receipt"),
            sql`${resources.deletedAt} IS NULL`,
            sql`${resources.metadata}->>'originalListingId' = ${resourceId}`,
          ),
        )
        .limit(1);

      if (hasReceiptHistory) {
        const existingMetadata =
          verifiedDeleteResource.metadata && typeof verifiedDeleteResource.metadata === "object"
            ? verifiedDeleteResource.metadata
            : {};

        await db.transaction(async (tx) => {
          await tx
            .update(resources)
            .set({
              visibility: "private",
              metadata: {
                ...existingMetadata,
                status: "archived",
                archivedAt: new Date().toISOString(),
                archivedReason: "transaction_history_preserved",
              },
            })
            .where(eq(resources.id, resourceId));

          await tx.insert(ledger).values({
            verb: "update",
            subjectId: userId,
            objectId: resourceId,
            objectType: "resource",
            resourceId,
            metadata: {
              source: "archive-resource-action",
              reason: "transaction-history",
            },
          } as NewLedgerEntry);
        });

        revalidatePath("/");
        revalidatePath("/marketplace");
        revalidatePath(`/marketplace/${resourceId}`);
        revalidatePath("/events");
        revalidatePath("/projects");
        revalidatePath("/groups");

        return {
          success: true,
          message: "Archived successfully. This offering has purchase history, so it was unlisted instead of deleted.",
          resourceId,
        } as ActionResult;
      }

      // Soft delete preserves historical references and enables audit/recovery workflows.
      await db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({ deletedAt: new Date() })
          .where(eq(resources.id, resourceId));

        await tx.insert(ledger).values({
          verb: "delete",
          subjectId: userId,
          objectId: resourceId,
          objectType: "resource",
          resourceId,
          metadata: { source: "delete-resource-action" },
        } as NewLedgerEntry);
      });

      revalidatePath("/");
      revalidatePath("/marketplace");
      revalidatePath("/events");
      revalidatePath("/projects");
      revalidatePath("/groups");

      return {
        success: true,
        message: "Deleted successfully",
        resourceId,
      } as ActionResult;
    },
  );

  if (!deleteFacadeResult.success) {
    return {
      success: false,
      message: deleteFacadeResult.error ?? "Failed to delete resource",
      error: { code: deleteFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const deleteActionResult = deleteFacadeResult.data as ActionResult;

  if (deleteActionResult?.success) {
    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_DELETED,
      entityType: "resource",
      entityId: resourceId,
      actorId: userId,
      payload: { resourceType: (verifiedDeleteResource.metadata as Record<string, unknown>)?.resourceKind ?? null },
    }).catch(() => {});
  }

  return deleteActionResult;
}

/**
 * Awards an EXISTING group badge to a member — group-admin gated (the platform
 * `assignBadgeToUser` requires siteRole=admin, which a group owner is not).
 *
 * The job badge-gate reads active `assign` ledger edges, so this is how a member
 * "gets" a badge that has no self-serve earn path (seeded badges with no training
 * modules / live class). Idempotent; safe to re-run.
 */
export async function awardBadgeToMemberAction(input: {
  groupId: string;
  memberId: string;
  badgeId: string;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.memberId?.trim() || !input.badgeId?.trim()) {
    return { success: false, message: "groupId, memberId, and badgeId are required", error: { code: "INVALID_INPUT" } };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to award badges", error: { code: "UNAUTHENTICATED" } };
  }

  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return { success: false, message: "You do not have permission to award badges for this group.", error: { code: "FORBIDDEN" } };
  }

  const [badge] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, input.badgeId), eq(resources.type, "badge"), sql`${resources.deletedAt} IS NULL`))
    .limit(1);
  if (!badge) return { success: false, message: "Badge not found", error: { code: "NOT_FOUND" } };

  const [member] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.memberId))
    .limit(1);
  if (!member) return { success: false, message: "Member not found", error: { code: "NOT_FOUND" } };

  // Idempotent — skip when the member already holds the badge. (postgres.js:
  // db.execute returns the rows array DIRECTLY.)
  const existing = (await db.execute(sql`
    SELECT id FROM ledger
    WHERE subject_id = ${input.memberId}::uuid
      AND resource_id = ${input.badgeId}::uuid
      AND verb = 'assign'
      AND is_active = true
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (existing.length > 0) {
    return { success: true, message: "Member already holds this badge." };
  }

  await db.insert(ledger).values({
    verb: "assign",
    subjectId: input.memberId,
    objectId: input.badgeId,
    objectType: "resource",
    resourceId: input.badgeId,
    isActive: true,
    metadata: { assignedBy: userId, assignedAt: new Date().toISOString(), groupId: input.groupId },
  });

  revalidatePath(`/groups/${input.groupId}`);
  return { success: true, message: "Badge awarded." };
}

export async function createBadgeResourceAction(input: {
  groupId: string;
  name: string;
  description: string;
  category?: string;
  level?: "beginner" | "intermediate" | "advanced" | "expert";
  icon?: string;
  requirements?: string[];
  /** Optional training curriculum authored with the badge (title required;
   *  duration in minutes). Server-sanitized: capped count/length, ids and
   *  order assigned here — never trusted from the client. */
  trainingModules?: Array<{ title: string; description?: string; duration?: number }>;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.name?.trim() || !input.description?.trim()) {
    return {
      success: false,
      message: "groupId, name, and description are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create badges",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const canWrite = await hasGroupWriteAccess(userId, input.groupId);
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create badges for this group.",
      error: { code: "FORBIDDEN" },
    };
  }

  const MAX_TRAINING_MODULES = 20;
  const sanitizedTrainingModules = (input.trainingModules ?? [])
    .slice(0, MAX_TRAINING_MODULES)
    .map((module, index) => ({
      id: `module-${index + 1}`,
      title: String(module.title ?? "").trim().slice(0, 200),
      description: String(module.description ?? "").trim().slice(0, 2000),
      // Authored modules are self-paced reading by default; richer types
      // (video/quiz) come with the full designer.
      type: "reading",
      content: String(module.description ?? "").trim().slice(0, 2000),
      duration:
        Number.isFinite(module.duration) && (module.duration as number) > 0
          ? Math.min(Math.round(module.duration as number), 480)
          : 10,
      order: index,
    }))
    .filter((module) => module.title.length > 0);

  const badgeFacadeResult = await updateFacade.execute(
    {
      type: "createBadgeResourceAction",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: input,
    },
    async () => {
      const result = await createResourceWithLedger({
        ownerId: input.groupId,
        name: input.name.trim(),
        type: "badge",
        description: input.description.trim(),
        content: input.description.trim(),
        visibility: "public",
        tags: [input.groupId],
        metadata: {
          resourceKind: "badge",
          entityType: "badge",
          groupId: input.groupId,
          groupTags: [input.groupId],
          icon: input.icon?.trim() || "\u{1F3C5}",
          category: input.category?.trim() || "community",
          level: input.level ?? "beginner",
          requirements: input.requirements ?? [],
          holders: [],
          jobsUnlocked: [],
          trainingModules: sanitizedTrainingModules,
        },
      });

      if (result.success) {
        await revalidateOwnerPaths(input.groupId);
        revalidatePath(`/rings/${input.groupId}`);
        revalidatePath(`/families/${input.groupId}`);
      }

      return result;
    },
  );

  if (!badgeFacadeResult.success) {
    return {
      success: false,
      message: badgeFacadeResult.error ?? "Failed to create badge",
      error: { code: badgeFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const badgeActionResult = badgeFacadeResult.data as ActionResult;

  if (badgeActionResult?.success && badgeActionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      entityType: "resource",
      entityId: badgeActionResult.resourceId,
      actorId: userId,
      payload: { resourceType: "badge", groupId: input.groupId },
    }).catch(() => {});
  }

  return badgeActionResult;
}

/**
 * Creates a live class resource (type "job") linked to a badge.
 *
 * A live class is a scheduled job with practical tasks that participants
 * must complete to earn the associated badge.
 *
 * @param input - Live class creation parameters.
 * @returns ActionResult with success/failure and the created resource ID.
 */
export async function createLiveClassAction(input: {
  groupId: string;
  badgeId: string;
  title: string;
  description: string;
  date: string;
  durationMinutes: number;
  maxParticipants?: number;
  location?: string;
  tasks?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.badgeId?.trim() || !input.title?.trim()) {
    return {
      success: false,
      message: "groupId, badgeId, and title are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (!input.date?.trim()) {
    return {
      success: false,
      message: "A date is required for the live class",
      error: { code: "INVALID_INPUT", details: "date is required" },
    };
  }

  const durationMinutes = typeof input.durationMinutes === "number" && input.durationMinutes > 0
    ? input.durationMinutes
    : 60;

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create live classes",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const canWrite = await canPostToGroup(userId, input.groupId, "create");
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create live classes for this group.",
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

  const liveClassFacadeResult = await updateFacade.execute(
    {
      type: "createLiveClassAction",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: input,
    },
    async () => {
      try {
        const tasksInput = Array.isArray(input.tasks) ? input.tasks : [];

        const result = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(resources)
            .values({
              name: input.title.trim(),
              type: "job",
              description: input.description?.trim() || null,
              content: input.description?.trim() || null,
              ownerId: input.groupId,
              visibility: "public",
              tags: [input.groupId],
              metadata: {
                resourceKind: "live_class",
                entityType: "job",
                groupId: input.groupId,
                badgeId: input.badgeId,
                classDate: input.date,
                durationMinutes,
                maxParticipants: input.maxParticipants ?? null,
                location: input.location?.trim() || null,
                status: "scheduled",
                enrolledCount: 0,
              },
            } as NewResource)
            .returning({ id: resources.id });

          await tx.insert(ledger).values({
            verb: "create",
            subjectId: userId,
            objectId: created.id,
            objectType: "resource",
            resourceId: created.id,
            metadata: {
              resourceType: "job",
              resourceKind: "live_class",
              badgeId: input.badgeId,
              groupId: input.groupId,
              source: "badge-live-class",
            },
          } as NewLedgerEntry);

          for (const rawTask of tasksInput) {
            if (!rawTask || typeof rawTask !== "object") continue;
            const taskName = String(rawTask.name ?? "").trim();
            if (!taskName) continue;
            const taskDescription = String(rawTask.description ?? "").trim();

            const [createdTask] = await tx
              .insert(resources)
              .values({
                name: taskName,
                type: "task",
                description: taskDescription || null,
                content: taskDescription || null,
                ownerId: input.groupId,
                visibility: "public",
                tags: [input.groupId],
                metadata: {
                  resourceKind: "task",
                  jobId: created.id,
                  groupId: input.groupId,
                  badgeId: input.badgeId,
                  required: rawTask.required !== false,
                },
              } as NewResource)
              .returning({ id: resources.id });

            await tx.insert(ledger).values({
              verb: "create",
              subjectId: userId,
              objectId: createdTask.id,
              objectType: "resource",
              resourceId: createdTask.id,
              metadata: {
                resourceType: "task",
                jobId: created.id,
                source: "badge-live-class",
              },
            } as NewLedgerEntry);
          }

          return created;
        });

        revalidatePath("/");
        revalidatePath("/create");
        revalidatePath("/projects");
        await revalidateOwnerPaths(input.groupId);

        return {
          success: true,
          message: "Live class created successfully",
          resourceId: result.id,
        } as ActionResult;
      } catch (error) {
        console.error("[createLiveClassAction] failed:", error);
        return {
          success: false,
          message: "Failed to create live class",
          error: { code: "SERVER_ERROR" },
        } as ActionResult;
      }
    },
  );

  if (!liveClassFacadeResult.success) {
    return {
      success: false,
      message: liveClassFacadeResult.error ?? "Failed to create live class",
      error: { code: liveClassFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const liveClassActionResult = liveClassFacadeResult.data as ActionResult;

  if (liveClassActionResult?.success && liveClassActionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      entityType: "resource",
      entityId: liveClassActionResult.resourceId,
      actorId: userId,
      payload: { resourceType: "live_class", groupId: input.groupId, badgeId: input.badgeId },
    }).catch(() => {});
  }

  return liveClassActionResult;
}

export async function createDocumentResourceAction(input: {
  groupId: string;
  title: string;
  content?: string;
  description?: string;
  tags?: string[];
  category?: string;
  showOnAbout?: boolean;
}): Promise<ActionResult> {
  if (!input.groupId?.trim() || !input.title?.trim()) {
    return {
      success: false,
      message: "groupId and title are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create documents",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const canWrite = await canPostToGroup(userId, input.groupId, "create");
  if (!canWrite) {
    return {
      success: false,
      message: "You do not have permission to create documents for this group.",
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

  const docFacadeResult = await updateFacade.execute(
    {
      type: "createDocumentResourceAction",
      actorId: userId,
      targetAgentId: input.groupId,
      payload: input,
    },
    async () => {
      try {
        const result = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(resources)
            .values({
              name: input.title.trim(),
              type: "document",
              description: input.description?.trim() ?? null,
              content: input.content?.trim() ?? null,
              ownerId: input.groupId,
              visibility: "members",
              tags: input.tags ?? [],
              metadata: {
                entityType: "document",
                resourceKind: "document",
                groupId: input.groupId,
                category: input.category ?? null,
                createdBy: userId,
                showOnAbout: input.showOnAbout === true,
              },
            } as NewResource)
            .returning({ id: resources.id });

          await tx.insert(ledger).values({
            verb: "create",
            subjectId: userId,
            objectId: created.id,
            objectType: "resource",
            resourceId: created.id,
            metadata: {
              resourceType: "document",
              groupId: input.groupId,
              source: "documents-tab",
            },
          } as NewLedgerEntry);

          return created;
        });

        await revalidateOwnerPaths(input.groupId);

        return {
          success: true,
          message: "Document created successfully",
          resourceId: result.id,
        } as ActionResult;
      } catch (error) {
        console.error("[createDocumentResourceAction] failed:", error);
        return {
          success: false,
          message: "Failed to create document",
          error: { code: "SERVER_ERROR" },
        } as ActionResult;
      }
    },
  );

  if (!docFacadeResult.success) {
    return {
      success: false,
      message: docFacadeResult.error ?? "Failed to create document",
      error: { code: docFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const docActionResult = docFacadeResult.data as ActionResult;

  if (docActionResult?.success && docActionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      entityType: "resource",
      entityId: docActionResult.resourceId,
      actorId: userId,
      payload: { resourceType: "document", groupId: input.groupId },
    }).catch(() => {});
  }

  return docActionResult;
}

export async function createProjectResource(input: {
  title: string;
  description: string;
  category: string;
  groupId: string;
  deadline?: string;
  timeframe?: { start?: string | null; end?: string | null };
  budget?: number | null;
  venueId?: string | null;
  venueStartTime?: string | null;
  venueEndTime?: string | null;
  jobs?: unknown[];
  localeId?: string | null;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
}): Promise<ActionResult> {
  if (!input.title?.trim() || !input.description?.trim() || !input.category || !input.groupId) {
    return {
      success: false,
      message: "Please fill in all required project fields",
      error: {
        code: "INVALID_INPUT",
      },
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

  try {
    const canWriteToGroup = await hasGroupWriteAccess(userId, input.groupId);
    if (!canWriteToGroup) {
      return {
        success: false,
        message: "You do not have permission to create projects for this group.",
        error: { code: "FORBIDDEN" },
      };
    }

    // Dedicated key lets project creation be throttled independently from generic resource writes.
    const check = await rateLimit(`projects:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
    if (!check.success) {
      return {
        success: false,
        message: "Rate limit exceeded. Please try again later.",
        error: { code: "RATE_LIMITED" },
      };
    }

    const ownerId = input.groupId || userId;
    const jobsInput = Array.isArray(input.jobs) ? input.jobs : [];
    const scopedLocaleIds = Array.from(
      new Set(
        [
          ...(Array.isArray(input.scopedLocaleIds) ? input.scopedLocaleIds : []),
          ...(input.localeId && input.localeId !== "all" ? [input.localeId] : []),
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
    let projectVisibility: VisibilityLevel = "public";
    if (!wantsGlobal) {
      projectVisibility = hasScopedLocales ? "locale" : "private";
    } else if (hasScopedLocales || hasScopedGroupsOrUsers) {
      projectVisibility = "locale";
    }
    const scopeTags = Array.from(new Set([...scopedLocaleIds, ...scopedGroupIds, ...scopedUserIds]));
    const normalizedTimeframe = {
      start:
        typeof input.timeframe?.start === "string" && input.timeframe.start.trim().length > 0
          ? input.timeframe.start
          : null,
      end:
        typeof input.timeframe?.end === "string" && input.timeframe.end.trim().length > 0
          ? input.timeframe.end
          : null,
    };

    // Project plus nested jobs/tasks are created atomically for structural consistency.
    const projectFacadeResult = await updateFacade.execute(
      {
        type: "createProjectResource",
        actorId: userId,
        targetAgentId: ownerId,
        payload: input,
      },
      async () => {
    const result = await db.transaction(async (tx) => {
      const [project] = await tx
        .insert(resources)
        .values({
          name: input.title.trim(),
          type: "project",
          description: input.description.trim(),
          content: input.description.trim(),
          ownerId,
          visibility: projectVisibility,
          tags: scopeTags,
          metadata: {
            entityType: "project",
            resourceKind: "project",
            category: input.category,
            groupId: input.groupId,
            chapterTags: scopedLocaleIds,
            deadline: input.deadline || null,
            timeframe:
              normalizedTimeframe.start || normalizedTimeframe.end
                ? normalizedTimeframe
                : undefined,
            budget: input.budget ?? null,
            venueId: input.venueId ?? null,
            venueStartTime: input.venueStartTime ?? null,
            venueEndTime: input.venueEndTime ?? null,
            localeId: scopedLocaleIds[0] ?? (input.localeId && input.localeId !== "all" ? input.localeId : null),
            scopedLocaleIds,
            scopedGroupIds,
            scopedUserIds,
            isGlobal: wantsGlobal,
            ...(input.eftValues ? { eftValues: input.eftValues } : {}),
            ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
            ...(input.auditValues ? { auditValues: input.auditValues } : {}),
          },
        } as NewResource)
        .returning({ id: resources.id });

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: project.id,
        objectType: "resource",
        resourceId: project.id,
        metadata: {
          resourceType: "project",
          source: "create-page",
        },
      } as NewLedgerEntry);

      for (const rawJob of jobsInput) {
        // Accept loosely typed job payloads but ignore malformed entries safely.
        if (!rawJob || typeof rawJob !== "object") continue;
        const job = rawJob as Record<string, unknown>;
        const jobTitle = String(job.title ?? "").trim();
        if (!jobTitle) continue;
        const jobDescription = String(job.description ?? "").trim();

        // Per-job visibility: a job may be independently marked globally
        // visible (surfaces in the group's locale/region/global) even under a
        // more restricted project; otherwise it inherits the project's.
        const jobIsGlobal = job.isGlobal === true;
        const jobVisibility = jobIsGlobal ? "public" : projectVisibility;

        const [createdJob] = await tx
          .insert(resources)
          .values({
            name: jobTitle,
            type: "job",
            description: jobDescription || null,
            content: jobDescription || null,
            ownerId,
            visibility: jobVisibility,
            tags: scopeTags,
              metadata: {
                resourceKind: "job",
                projectId: project.id,
                groupId: input.groupId,
                chapterTags: scopedLocaleIds,
                scopedLocaleIds,
                scopedGroupIds,
                scopedUserIds,
                isGlobal: jobIsGlobal || wantsGlobal,
                category: job.category ?? null,
                priority: job.priority ?? null,
                location: job.location ?? null,
              maxAssignees: job.maxAssignees ?? null,
              requiredBadges: Array.isArray(job.requiredBadges) ? job.requiredBadges : [],
              skills: Array.isArray(job.skills) ? job.skills : [],
              // Pay model (alongside task points): a fixed cash amount for the
              // whole job, an hourly cash rate against tracked timer time, or
              // `volunteer` (no cash — completion mints a Thanks voucher the
              // group claims from each volunteer).
              payKind:
                job.payKind === "fixed" || job.payKind === "hourly" || job.payKind === "volunteer"
                  ? job.payKind
                  : null,
              payAmountCents:
                job.payKind === "fixed" && Number.isInteger(job.payAmountCents) && (job.payAmountCents as number) > 0
                  ? job.payAmountCents
                  : null,
              hourlyRateCents:
                job.payKind === "hourly" && Number.isInteger(job.hourlyRateCents) && (job.hourlyRateCents as number) > 0
                  ? job.hourlyRateCents
                  : null,
              // Creator-selected claim gating (job-claim approval flow).
              claimApprovalRequired: job.claimApprovalRequired === true,
              claimGateMembership: job.claimGateMembership === true,
              claimGateAdmin: job.claimGateAdmin === true,
              // Schedule fields set at creation time (org agents pass these on
              // nested jobs so no follow-up jobs.update is required). Stored as
              // strings; the caller (group-action-tools) validates ISO shape.
              startDate: typeof job.startDate === "string" ? job.startDate : null,
              deadline: typeof job.deadline === "string" ? job.deadline : null,
              date: typeof job.date === "string" ? job.date : null,
              // Hour budget — hourly payout clamps to this (job-completion.ts).
              maxHours:
                typeof job.maxHours === "number" && Number.isFinite(job.maxHours) && job.maxHours > 0
                  ? job.maxHours
                  : null,
              // Job-level points for task-less jobs (split at completion).
              points:
                typeof job.points === "number" && Number.isFinite(job.points) && job.points >= 0
                  ? job.points
                  : null,
            },
          } as NewResource)
          .returning({ id: resources.id });

        await tx.insert(ledger).values({
          verb: "create",
          subjectId: userId,
          objectId: createdJob.id,
          objectType: "resource",
          resourceId: createdJob.id,
          metadata: {
            resourceType: "job",
            projectId: project.id,
            source: "create-page",
          },
        } as NewLedgerEntry);

        const tasks = Array.isArray(job.tasks) ? (job.tasks as unknown[]) : [];
        for (const rawTask of tasks) {
          // Task rows are optional children; invalid records are skipped rather than failing the project.
          if (!rawTask || typeof rawTask !== "object") continue;
          const task = rawTask as Record<string, unknown>;
          const taskName = String(task.name ?? "").trim();
          if (!taskName) continue;
          const taskDescription = String(task.description ?? "").trim();

          const [createdTask] = await tx
            .insert(resources)
            .values({
              name: taskName,
              type: "task",
              description: taskDescription || null,
              content: taskDescription || null,
              ownerId,
              visibility: projectVisibility,
              tags: scopeTags,
              metadata: {
                resourceKind: "task",
                projectId: project.id,
                jobId: createdJob.id,
                groupId: input.groupId,
                chapterTags: scopedLocaleIds,
                scopedLocaleIds,
                scopedGroupIds,
                scopedUserIds,
                isGlobal: wantsGlobal,
                estimatedTime: task.estimatedTime ?? null,
                points: task.points ?? null,
                required: task.required ?? true,
                // Task work window + advisory hour budget (2026-07-10).
                startDate: typeof task.startDate === "string" ? task.startDate : null,
                deadline: typeof task.deadline === "string" ? task.deadline : null,
                maxHours:
                  typeof task.maxHours === "number" && Number.isFinite(task.maxHours) && task.maxHours > 0
                    ? task.maxHours
                    : null,
              },
            } as NewResource)
            .returning({ id: resources.id });

          await tx.insert(ledger).values({
            verb: "create",
            subjectId: userId,
            objectId: createdTask.id,
            objectType: "resource",
            resourceId: createdTask.id,
            metadata: {
              resourceType: "task",
              projectId: project.id,
              jobId: createdJob.id,
              source: "create-page",
            },
          } as NewLedgerEntry);
        }
      }

      return project;
    });

    const grantEntries = [
      ...scopedGroupIds.map((groupId) => ({ subjectId: groupId })),
      ...scopedUserIds.map((subjectId) => ({ subjectId })),
    ];
    if (grantEntries.length > 0) {
      try {
        await db.insert(ledger).values(
          grantEntries.map((entry) => ({
            verb: "grant" as const,
            subjectId: entry.subjectId,
            objectId: result.id,
            objectType: "resource" as const,
            resourceId: result.id,
            isActive: true,
            metadata: { action: "view", source: "visibility-scope" },
          } as NewLedgerEntry))
        );
      } catch (error) {
        console.error("[createProjectResource] grant creation failed:", error);
      }
    }

    revalidatePath("/");
    revalidatePath("/create");
    revalidatePath("/projects");
    revalidatePath("/groups");
    void syncMurmurationsProfilesForActor(userId).catch((error) => {
      console.error("[murmurations] createProjectResource sync failed:", error);
    });

    return {
      success: true,
      message: "Created successfully",
      resourceId: result.id,
    } as ActionResult;
      },
    );

    if (!projectFacadeResult.success) {
      return {
        success: false,
        message: projectFacadeResult.error ?? "Failed to create project",
        error: { code: projectFacadeResult.errorCode ?? "SERVER_ERROR" },
      };
    }

    const projectActionResult = projectFacadeResult.data as ActionResult;

    if (projectActionResult?.success && projectActionResult.resourceId) {
      emitDomainEvent({
        eventType: EVENT_TYPES.RESOURCE_CREATED,
        entityType: "resource",
        entityId: projectActionResult.resourceId,
        actorId: userId,
        payload: { resourceType: "project", groupId: input.groupId },
      }).catch(() => {});
    }

    return projectActionResult;
  } catch (error) {
    return {
      success: false,
      message: "Failed to create project",
      error: {
        code: "SERVER_ERROR",
      },
    };
  }
}
