"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewLedgerEntry,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq } from "drizzle-orm";

import { resolveWriteActor } from "@/lib/auth/write-actor";
import { federatedWrite, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";
import type { ActionResult, CommentData } from "./types";

const MAX_COMMENT_CONTENT_LENGTH = 10000;
/** Verb phrase used in this action's refusal copy. */
const COMMENT_ACTION_LABEL = "post a comment";
/** `resources.id` is a uuid column — a non-uuid lookup errors rather than misses. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function postCommentAction(
  resourceId: string,
  content: string,
  parentCommentId?: string | null,
): Promise<ActionResult> {
  // Resolve the owner first: a federated principal's standing is checked against
  // the group that owns the thread as well as the instance's primary agent.
  const [resourceOwner] = UUID_RE.test(resourceId)
    ? await db
        .select({ ownerId: resources.ownerId })
        .from(resources)
        .where(eq(resources.id, resourceId))
        .limit(1)
    : [];

  const actor = await resolveWriteActor({
    capability: "comment",
    actionLabel: COMMENT_ACTION_LABEL,
    standingAgentIds: resourceOwner?.ownerId ? [resourceOwner.ownerId] : [],
    // Local sessions keep persona attribution (the pre-S-1 getOperatingAgentId
    // behavior); a federated principal has no local persona cookie.
    preferActivePersona: true,
  });
  if (!actor.allowed) {
    return {
      success: false,
      message: actor.message,
      error: { code: actor.code },
    };
  }
  const userId = actor.actorId;

  if (!content.trim()) {
    return {
      success: false,
      message: "Comment cannot be empty.",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (content.length > MAX_COMMENT_CONTENT_LENGTH) {
    return {
      success: false,
      message: `Comment exceeds maximum length of ${MAX_COMMENT_CONTENT_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const check = await rateLimit(`comment:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  // Resource owner (already loaded above for the standing check) routes federation.
  const targetAgentId = resourceOwner?.ownerId ?? userId;

  const facadeResult = await federatedWrite(
    {
      type: "postCommentAction",
      actorId: userId,
      targetAgentId,
      payload: { resourceId, content, parentCommentId },
    },
    async () => {
      try {
        const [entry] = await db
          .insert(ledger)
          .values({
            verb: "comment",
            subjectId: userId,
            objectId: resourceId,
            objectType: "resource",
            resourceId,
            metadata: {
              content: content.trim(),
              parentCommentId: parentCommentId ?? null,
            },
          } as NewLedgerEntry)
          .returning({ id: ledger.id });

        revalidatePath(`/events/${resourceId}`);
        revalidatePath(`/posts/${resourceId}`);

        return {
          success: true,
          message: "Comment posted.",
          resourceId: entry.id,
        } as ActionResult;
      } catch (error) {
        console.error("[postCommentAction] failed:", error);
        return {
          success: false,
          message: "Unable to post comment. Please try again.",
          error: { code: "SERVER_ERROR" },
        } as ActionResult;
      }
    },
  );

  if (!facadeResult.success) {
    return {
      success: false,
      message: facadeResult.error ?? "Failed to post comment",
      error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const actionResult = facadeResult.data as ActionResult;

  if (actionResult?.success && actionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.POST_COMMENTED,
      entityType: "resource",
      entityId: resourceId,
      actorId: userId,
      payload: { commentId: actionResult.resourceId, parentCommentId: parentCommentId ?? null },
    }).catch(() => {});
  }

  return actionResult;
}

export async function fetchCommentsAction(
  resourceId: string,
): Promise<{ success: true; comments: CommentData[] } | { success: false; error: string }> {
  try {
    const rows = await db
      .select({
        id: ledger.id,
        subjectId: ledger.subjectId,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
        authorName: agents.name,
        authorImage: agents.image,
      })
      .from(ledger)
      .innerJoin(agents, eq(agents.id, ledger.subjectId))
      .where(
        and(
          eq(ledger.verb, "comment"),
          eq(ledger.resourceId, resourceId),
          eq(ledger.isActive, true),
        ),
      )
      .orderBy(ledger.timestamp);

    const comments: CommentData[] = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const isGift = meta.isGift === true;
      const giftType = meta.giftType === "voucher" || meta.giftType === "thanks"
        ? (meta.giftType as "voucher" | "thanks")
        : undefined;

      return {
        id: row.id,
        authorId: row.subjectId,
        authorName: row.authorName ?? "Unknown",
        authorImage: row.authorImage,
        content: (meta.content as string) ?? "",
        timestamp: row.timestamp.toISOString(),
        parentCommentId: (meta.parentCommentId as string) ?? null,
        ...(isGift && {
          isGift: true,
          giftType,
          giftMessage: typeof meta.giftMessage === "string" ? meta.giftMessage : undefined,
          voucherId: typeof meta.voucherId === "string" ? meta.voucherId : undefined,
          voucherName: typeof meta.voucherName === "string" ? meta.voucherName : undefined,
          thanksTokenCount: typeof meta.thanksTokenCount === "number" ? meta.thanksTokenCount : undefined,
        }),
      };
    });

    return { success: true, comments };
  } catch (error) {
    console.error("[fetchCommentsAction] failed:", error);
    return { success: false, error: "Unable to load comments." };
  }
}
