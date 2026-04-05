"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES, federatedWrite } from "@/lib/federation";
import {
  getCurrentUserId,
  toggleLedgerInteraction,
} from "./helpers";
import type { ActionResult, ReactionType, TargetType } from "./types";
import { isUuid, REACTION_TYPES } from "./types";

type ReactionSummary = {
  counts: Partial<Record<ReactionType, number>>;
  totalCount: number;
  currentUserReaction: ReactionType | null;
};

/**
 * Toggles a "like" reaction on a target entity.
 *
 * @param {string} targetId - Target entity identifier (UUID or metadata-only ID).
 * @param {TargetType} [targetType="post"] - Domain type of the target.
 * @param {string} [pathToRevalidate] - Optional path to revalidate after successful toggle.
 * @returns {Promise<ActionResult>} Interaction state result (`active` indicates current state).
 * @throws {Error} Unexpected database errors may propagate from lower-level helpers.
 * @example
 * ```ts
 * await toggleLikeOnTarget("target-id", "post", "/feed");
 * ```
 */
export async function toggleLikeOnTarget(
  targetId: string,
  targetType: TargetType = "post",
  pathToRevalidate?: string
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to like content." };

  // Shared social rate limit throttles high-frequency interaction spam.
  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const writeResult = await federatedWrite(
    {
      type: 'toggleLikeOnTarget',
      actorId: userId,
      targetAgentId: targetId,
      payload: { targetId, targetType },
    },
    async () => {
      const r = await setReactionOnTarget(targetId, targetType, "like");
      if (pathToRevalidate) revalidatePath(pathToRevalidate);
      return r;
    },
  );

  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? "Failed to toggle like." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.REACTION_TOGGLED,
    entityType: targetType,
    entityId: targetId,
    actorId: userId,
    payload: { reactionType: 'like' },
  }).catch(() => {});

  return writeResult.data ?? { success: true, message: "like toggled" };
}

export async function setReactionOnTarget(
  targetId: string,
  targetType: TargetType = "post",
  reactionType: ReactionType = "like",
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to react to content." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const writeResult = await federatedWrite(
    {
      type: 'setReactionOnTarget',
      actorId: userId,
      targetAgentId: targetId,
      payload: { targetId, targetType, reactionType },
    },
    async () => {
      return await db.transaction(async (tx) => {
        const existing = await tx.query.ledger.findMany({
          where: and(
            eq(ledger.subjectId, userId),
            eq(ledger.verb, "react"),
            eq(ledger.isActive, true),
            sql`${ledger.metadata}->>'targetId' = ${targetId}`,
            inArray(sql<string>`${ledger.metadata}->>'interactionType'`, [...REACTION_TYPES]),
          ),
          columns: { id: true, metadata: true },
        });

        const currentReaction = existing.find((row) => {
          const metadata = (row.metadata ?? {}) as Record<string, unknown>;
          return metadata.interactionType === reactionType;
        });

        if (existing.length > 0) {
          await tx.execute(sql`
            UPDATE ledger
            SET is_active = false, expires_at = NOW()
            WHERE id IN (${sql.join(existing.map((row) => sql`${row.id}`), sql`, `)})
          `);
        }

        if (currentReaction) {
          return {
            success: true,
            message: `${reactionType} removed`,
            active: false,
            reactionType: null,
          } as ActionResult;
        }

        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "react",
          objectId: isUuid(targetId) ? targetId : null,
          objectType: targetType,
          metadata: {
            interactionType: reactionType,
            targetId,
            targetType,
          },
        } as NewLedgerEntry);

        return {
          success: true,
          message: `${reactionType} added`,
          active: true,
          reactionType,
        } as ActionResult;
      });
    },
  );

  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? "Failed to set reaction." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.REACTION_TOGGLED,
    entityType: targetType,
    entityId: targetId,
    actorId: userId,
    payload: { reactionType, active: writeResult.data?.active },
  }).catch(() => {});

  return writeResult.data ?? { success: true, message: `${reactionType} toggled` };
}

export async function fetchReactionSummaries(
  targetIds: string[],
  targetType: TargetType
): Promise<Record<string, ReactionSummary>> {
  if (targetIds.length === 0) return {};

  const userId = await getCurrentUserId();
  const rows = await db.query.ledger.findMany({
    where: and(
      eq(ledger.verb, "react"),
      eq(ledger.isActive, true),
      inArray(sql<string>`${ledger.metadata}->>'targetId'`, targetIds),
    ),
    columns: {
      subjectId: true,
      metadata: true,
    },
  });

  const summaries: Record<string, ReactionSummary> = {};
  for (const id of targetIds) {
    summaries[id] = { counts: {}, totalCount: 0, currentUserReaction: null };
  }

  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const reactionTargetId = typeof metadata.targetId === "string" ? metadata.targetId : "";
    const reactionTargetType = typeof metadata.targetType === "string" ? metadata.targetType : "";
    const interactionType = typeof metadata.interactionType === "string" ? metadata.interactionType : "";

    if (!reactionTargetId || reactionTargetType !== targetType) continue;
    if (!(REACTION_TYPES as readonly string[]).includes(interactionType)) continue;
    if (!summaries[reactionTargetId]) continue;

    const typedReaction = interactionType as ReactionType;
    summaries[reactionTargetId].counts[typedReaction] =
      (summaries[reactionTargetId].counts[typedReaction] ?? 0) + 1;
    summaries[reactionTargetId].totalCount += 1;
    if (userId && row.subjectId === userId) {
      summaries[reactionTargetId].currentUserReaction = typedReaction;
    }
  }

  return summaries;
}

/**
 * Toggles a "thank" reaction on a target entity.
 *
 * @param {string} targetId - Target entity identifier.
 * @param {TargetType} [targetType="post"] - Domain type for the target.
 * @returns {Promise<ActionResult>} Interaction state result.
 * @throws {Error} Unexpected database errors may propagate from helper calls.
 * @example
 * ```ts
 * await toggleThankOnTarget("target-id");
 * ```
 */
export async function toggleThankOnTarget(
  targetId: string,
  targetType: TargetType = "post"
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to thank someone." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const writeResult = await federatedWrite(
    {
      type: 'toggleThankOnTarget',
      actorId: userId,
      targetAgentId: targetId,
      payload: { targetId, targetType },
    },
    async () => {
      return toggleLedgerInteraction(userId, "react", "thank", targetId, targetType);
    },
  );

  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? "Failed to toggle thank." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.REACTION_TOGGLED,
    entityType: targetType,
    entityId: targetId,
    actorId: userId,
    payload: { reactionType: 'thank' },
  }).catch(() => {});

  return writeResult.data ?? { success: true, message: "thank toggled" };
}
