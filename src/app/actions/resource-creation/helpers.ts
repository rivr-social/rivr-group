"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type MembershipTier,
  type NewLedgerEntry,
  type NewResource,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { embedResource, scheduleEmbedding } from "@/lib/ai";
import { hasEntitlement } from "@/lib/billing";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { ensureLocalNode, queueEntityExportEvents } from "@/lib/federation";
import { getExecutionContext } from "@/lib/federation/execution-context";
import { getAgent } from "@/lib/queries/agents";
import { isGroupAdmin } from "@/app/actions/group-admin";

import type { ActionResult, CreateResourceInput, MemberCapabilityVerb } from "./types";
import { GROUP_LIKE_OWNER_AGENT_TYPES, resolveGroupMemberCapability } from "./types";

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

  if (resolvedUserId) {
    return resolvedUserId;
  }

  // Federated remote-viewer fallback (sovereign-homed admins viewing via SSO):
  // plain auth() sees no NextAuth JWT for them, so resource creation/update was
  // invisible to remote-homed group admins. Normalized to a local agent id via
  // the interactions helper (GRP-DSN-001). Lazy import avoids a circular dep
  // through the actions barrels.
  const { getCurrentUserId } = await import("@/app/actions/interactions/helpers");
  const sessionActorId = await getCurrentUserId();
  if (sessionActorId) return sessionActorId;

  // Cookie-only remote viewers (rivr_remote_viewer, no unified session) were
  // still invisible here — the 2026-07-16 fix surfaced the group as an owner
  // option for SSO-landed admins, but their SUBMIT then 401'd in this helper.
  // getAuthenticatedActorId is the established session-OR-cookie resolver
  // (same combo the job-qa/project surfaces use for authority).
  const { getAuthenticatedActorId } = await import("@/lib/server-auth");
  return getAuthenticatedActorId();
}

/**
 * MANAGE/admin authorization on a group-like agent. Delegates to the established
 * {@link isGroupAdmin} gate (active admin/moderator ledger role, creatorId, or
 * adminIds metadata). Deliberately does NOT accept a plain `join`/`belong`
 * membership row (the C4-class ambient-claim hole) or tier/plan entitlement —
 * structural and destructive operations require an explicit admin grant.
 */
export async function hasGroupManageAccess(userId: string, groupId: string): Promise<boolean> {
  const [group] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, groupId), inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES])))
    .limit(1);

  if (!group) return false;
  if (await isGroupAdmin(userId, groupId)) return true;

  // Delegated authority: an agent acting under an MCP delegation inherits its
  // controller's group-admin rights. This is how a group's own agent (or an
  // agent an admin has delegated to) manages the group on that admin's behalf —
  // the controller is the verified human principal, the actor is who the work
  // is attributed to. Only MCP sessions carry a controllerId, so a normal web
  // request (no execution context) never takes this branch.
  const context = getExecutionContext();
  if (
    context?.source === "mcp" &&
    context.controllerId &&
    context.controllerId !== userId &&
    (await isGroupAdmin(context.controllerId, groupId))
  ) {
    return true;
  }

  return false;
}

/**
 * Structural/admin write gate. An alias for {@link hasGroupManageAccess};
 * retained so structural call sites keep a stable name. Content-creation call
 * sites must use {@link canPostToGroup} instead.
 */
export async function hasGroupWriteAccess(userId: string, groupId: string): Promise<boolean> {
  return hasGroupManageAccess(userId, groupId);
}

/**
 * CONTENT authorization on a group-like agent: a member may author content when
 * (a) they have manage access (admins always may), OR (b) the group's per-verb
 * member capability is enabled (default-on) AND they hold a real active
 * membership edge AND satisfy any required tier/plan entitlement. The membership
 * edge is necessary-but-not-sufficient — it only grants posting because the
 * explicit per-group policy permits it.
 */
export async function canPostToGroup(
  userId: string,
  groupId: string,
  verb: MemberCapabilityVerb = "create",
): Promise<boolean> {
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES])))
    .limit(1);

  if (!group) return false;

  const metadata = ((group.metadata ?? {}) as Record<string, unknown>);

  // Admins/owner always may.
  if (await hasGroupManageAccess(userId, groupId)) return true;

  // Per-group toggle must permit this content verb for members.
  if (!resolveGroupMemberCapability(metadata, verb)) return false;

  // Required paid tier, if the group gates writes behind one.
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
    // Every public/locale/members resource created on this sovereign instance
    // must circulate to the global hub. Anchor the export on this instance's
    // own self-node (the canonical federation origin) rather than gating on an
    // explicit `federate` flag or an owner-hosted node — normal creates never
    // set the flag, and group-owned content is authored by members who are not
    // the node owner. queueEntityExportEvents applies the visibility filter
    // (public/locale/members only), so private resources still stay local.
    const federationNode = await ensureLocalNode();

    // Autobot PROVENANCE model (H2): content an autobot authors is OWNED BY ITS
    // CONTROLLER (the human), with the autobot recorded as provenance — the same
    // shape group posts use for postedAsGroup/postedByAgentId. Ownership is the
    // delete/moderation gate (see canModifyResource), so attributing autobot
    // output to its controller is what lets the human see, moderate, and delete
    // it. HUMANS and PERSONAS are unaffected (a persona's own agent keeps
    // authorship). Applies only when the autobot would otherwise own the content
    // itself — never when an explicit group `input.ownerId` is in play (that
    // stays group-owned, gated below) — and falls back to current behavior when
    // no controllerId is available so we never null-own.
    const executionContext = getExecutionContext();
    const hasExplicitOwner =
      typeof input.ownerId === "string" && input.ownerId.trim().length > 0;
    const requestedOwnerId = input.ownerId ?? userId;
    // Only re-home to the controller when the autobot is DEFAULTING to owning the
    // content itself (no explicit `input.ownerId` supplied). An explicit owner —
    // e.g. a group the agent acts AS — must stay owned by that principal. Without
    // this guard, a group agent acting under a human controller (actorId ===
    // groupId === requestedOwnerId) would silently re-home group-owned resources
    // to the human, and the group actor could then no longer modify them
    // (canModifyResource compares the group actor to the human owner → FORBIDDEN).
    // Projects don't hit this because createProjectResource inserts directly; the
    // guard brings events/offerings/etc. that route through here into parity.
    const isAutobotControllerContent =
      executionContext?.actorType === "autobot" &&
      Boolean(executionContext.controllerId) &&
      !hasExplicitOwner &&
      requestedOwnerId === userId;

    let ownerId = requestedOwnerId;
    let autobotProvenance:
      | { createdByAgentId: string; createdByName: string | null }
      | null = null;
    if (isAutobotControllerContent) {
      const autobotAgent = await getAgent(userId);
      ownerId = executionContext!.controllerId!;
      autobotProvenance = {
        createdByAgentId: userId,
        createdByName: autobotAgent?.name ?? null,
      };
    }

    if (!isAutobotControllerContent && ownerId !== userId) {
      const [owner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, ownerId), inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES])))
        .limit(1);
      if (!owner || !(await canPostToGroup(userId, ownerId, "create"))) {
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
          metadata: {
            ...(input.metadata ?? {}),
            ...(autobotProvenance ?? {}),
          },
          embeds: input.embeds ?? [],
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
          ...(autobotProvenance ?? {}),
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
