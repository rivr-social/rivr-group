"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewLedgerEntry,
  type NewResource,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { embedResource, scheduleEmbedding } from "@/lib/ai";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { getHostedNodeForOwner, queueEntityExportEvents } from "@/lib/federation";
import { getExecutionContext } from "@/lib/federation/execution-context";
import { hasEntitlement } from "@/lib/billing";
import type { MembershipTier } from "@/db/schema";

import type { ActionResult, CreateResourceInput } from "./types";
import { GROUP_LIKE_OWNER_AGENT_TYPES } from "./types";

const MEMBERSHIP_TIER_VALUES: MembershipTier[] = [
  "basic",
  "host",
  "seller",
  "organizer",
  "steward",
];

function normalizeRequiredTier(metadata: Record<string, unknown>): MembershipTier | null {
  const direct = metadata.writeMembershipTier;
  if (typeof direct === "string" && MEMBERSHIP_TIER_VALUES.includes(direct as MembershipTier)) {
    return direct as MembershipTier;
  }

  const accessPolicy = metadata.accessPolicy;
  if (accessPolicy && typeof accessPolicy === "object" && !Array.isArray(accessPolicy)) {
    const nested = (accessPolicy as Record<string, unknown>).writeMembershipTier;
    if (typeof nested === "string" && MEMBERSHIP_TIER_VALUES.includes(nested as MembershipTier)) {
      return nested as MembershipTier;
    }
  }

  return null;
}

function normalizeRequiredPlanId(metadata: Record<string, unknown>): string | null {
  const direct = metadata.writeMembershipPlanId;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const accessPolicy = metadata.accessPolicy;
  if (accessPolicy && typeof accessPolicy === "object" && !Array.isArray(accessPolicy)) {
    const nested = (accessPolicy as Record<string, unknown>).writeMembershipPlanId;
    if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  }

  return null;
}

export async function resolveAuthenticatedUserId(): Promise<string | null> {
  const executionContext = getExecutionContext();
  if (executionContext) {
    return executionContext.actorId;
  }

  const session = await auth();
  let resolvedUserId = session?.user?.id ?? null;

  if (!resolvedUserId && session?.user?.email) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, session.user.email))
      .limit(1);
    resolvedUserId = agent?.id ?? null;
  }

  return resolvedUserId;
}

export async function hasGroupWriteAccess(userId: string, groupId: string): Promise<boolean> {
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES])))
    .limit(1);

  if (!group) return false;

  const metadata = ((group.metadata ?? {}) as Record<string, unknown>);
  const creatorId = metadata.creatorId;
  if (typeof creatorId === "string" && creatorId === userId) return true;

  const requiredTier = normalizeRequiredTier(metadata);
  if (requiredTier) {
    const entitled = await hasEntitlement(userId, requiredTier);
    if (!entitled) return false;
  }

  const requiredPlanId = normalizeRequiredPlanId(metadata);

  const rows = await db.execute(sql`
    SELECT id
         , metadata
    FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND object_id = ${groupId}::uuid
      AND is_active = true
      AND verb IN ('own', 'manage', 'join', 'belong')
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `);

  const membership = (rows as Array<Record<string, unknown>>)[0];
  if (!membership) return false;

  if (requiredPlanId) {
    const membershipMeta =
      membership.metadata && typeof membership.metadata === "object"
        ? (membership.metadata as Record<string, unknown>)
        : {};
    const planId =
      typeof membershipMeta.membershipPlanId === "string"
        ? membershipMeta.membershipPlanId
        : typeof membershipMeta.planId === "string"
          ? membershipMeta.planId
          : null;
    if (planId !== requiredPlanId) {
      return false;
    }
  }

  return true;
}

export async function canModifyResource(userId: string, resourceId: string): Promise<{
  allowed: boolean;
  resource?: {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    metadata: Record<string, unknown> | null;
    isPublic: boolean;
    visibility: string | null;
    tags: string[] | null;
  };
}> {
  const [resource] = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
      isPublic: resources.isPublic,
      visibility: resources.visibility,
      tags: resources.tags,
    })
    .from(resources)
    .where(and(eq(resources.id, resourceId), sql`${resources.deletedAt} IS NULL`))
    .limit(1);

  if (!resource) return { allowed: false };
  if (resource.ownerId === userId) return { allowed: true, resource };

  const ownerIsGroup = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, resource.ownerId), inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES])))
    .limit(1);

  if (ownerIsGroup.length === 0) return { allowed: false, resource };
  const canWrite = await hasGroupWriteAccess(userId, resource.ownerId);
  return { allowed: canWrite, resource };
}

export async function revalidateOwnerPaths(ownerId: string) {
  const [owner] = await db
    .select({ type: agents.type })
    .from(agents)
    .where(eq(agents.id, ownerId))
    .limit(1);

  const basePath =
    owner?.type === "ring"
      ? `/rings/${ownerId}`
      : owner?.type === "family"
        ? `/families/${ownerId}`
        : `/groups/${ownerId}`;

  revalidatePath(basePath);
  revalidatePath(`${basePath}/docs`);
}

export async function createResourceWithLedger(input: CreateResourceInput): Promise<ActionResult> {
  const resolvedUserId = await resolveAuthenticatedUserId();

  if (!resolvedUserId) {
    return {
      success: false,
      message: "You must be logged in to create content",
      error: {
        code: "UNAUTHENTICATED",
      },
    };
  }

  if (!input.name.trim()) {
    return {
      success: false,
      message: "A title is required",
      error: {
        code: "INVALID_INPUT",
        details: "name is required",
      },
    };
  }

  try {
    const userId = resolvedUserId;
    const federationNode =
      input.federate === true ? await getHostedNodeForOwner(userId) : null;
    if (input.federate === true && !federationNode) {
      return {
        success: false,
        message: "Federation is not enabled for this account.",
        error: {
          code: "FORBIDDEN",
          details: "Only hosted-node owners can federate content from this deployment.",
        },
      };
    }
    const ownerId = input.ownerId ?? userId;
    if (ownerId !== userId) {
      const [owner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, ownerId), eq(agents.type, "organization")))
        .limit(1);
      if (!owner || !(await hasGroupWriteAccess(userId, ownerId))) {
        return {
          success: false,
          message: "You do not have permission to create content for this group.",
          error: { code: "FORBIDDEN" },
        };
      }
    }
    // Shared social bucket throttles high-volume content creation by actor.
    const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
    if (!check.success) {
      return {
        success: false,
        message: "Rate limit exceeded. Please try again later.",
        error: {
          code: "RATE_LIMITED",
        },
      };
    }

    // Keep resource creation and audit trail write atomic.
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(resources)
        .values({
          name: input.name.trim(),
          type: input.type,
          description: input.description?.trim() || null,
          content: input.content?.trim() || null,
          ownerId,
          visibility: input.visibility ?? "public",
          tags: input.tags ?? [],
          metadata: input.metadata ?? {},
          ...(input.location ? {
            location: {
              type: "Point" as const,
              coordinates: [input.location.lng, input.location.lat],
            },
          } : {}),
        } as NewResource)
        .returning({ id: resources.id });

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: created.id,
        objectType: "resource",
        resourceId: created.id,
        metadata: {
          resourceType: input.type,
          source: "create-page",
          ...(input.metadata ?? {}),
        },
      } as NewLedgerEntry);

      return created;
    });

    // Revalidate all surfaces where newly created resources can appear.
    revalidatePath("/");
    revalidatePath("/create");
    revalidatePath("/marketplace");
    revalidatePath("/events");
    revalidatePath("/projects");
    revalidatePath("/groups");

    // Fire-and-forget: generate semantic embedding from name + description.
    scheduleEmbedding(() =>
      embedResource(result.id, input.name, input.description)
    );
    void syncMurmurationsProfilesForActor(ownerId).catch((error) => {
      console.error("[murmurations] createResourceWithLedger sync failed:", error);
    });
    if (federationNode) {
      void queueEntityExportEvents({
        originNodeId: federationNode.id,
        resourceIds: [result.id],
      }).catch((error) => {
        console.error("[federation] createResourceWithLedger queue failed:", error);
      });
    }

    return {
      success: true,
      message: "Created successfully",
      resourceId: result.id,
    };
  } catch (error) {
    // Server-side details are logged, while clients receive a stable error contract.
    console.error("[createResourceWithLedger] Error:", error);
    return {
      success: false,
      message: "Failed to create item",
      error: {
        code: "SERVER_ERROR",
      },
    };
  }
}
