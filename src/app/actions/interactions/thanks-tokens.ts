"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES, federatedWrite } from "@/lib/federation";
import {
  getCurrentUserId,
} from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";


export async function sendThanksTokenAction(
  tokenId: string,
  recipientId: string,
  message?: string,
  contextId?: string,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to send a thanks token." };
  if (!isUuid(tokenId) || !isUuid(recipientId)) {
    return { success: false, message: "Invalid thanks token or recipient id." };
  }
  if (userId === recipientId) {
    return { success: false, message: "You cannot send a thanks token to yourself." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const result = await federatedWrite(
    {
      type: 'sendThanksTokenAction',
      actorId: userId,
      targetAgentId: recipientId,
      payload: { tokenId, recipientId, message, contextId },
    },
    async () => {
      const [token] = await db
        .select({
          id: resources.id,
          ownerId: resources.ownerId,
          type: resources.type,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(eq(resources.id, tokenId))
        .limit(1);

      if (!token) throw new Error("Thanks token not found.");
      if (token.type !== "thanks_token") {
        throw new Error("Resource is not a thanks token.");
      }
      if (token.ownerId !== userId) {
        throw new Error("You can only send thanks tokens you own.");
      }

      const metadata = (token.metadata ?? {}) as Record<string, unknown>;
      const priorHistory = Array.isArray(metadata.transferHistory)
        ? metadata.transferHistory.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        : [];
      const transferHistory = [
        ...priorHistory,
        {
          from: userId,
          to: recipientId,
          at: new Date().toISOString(),
          message: message ?? "",
          kind: "send",
        },
      ];
      const enteredAccountAt = new Date();

      await db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({
            ownerId: recipientId,
            enteredAccountAt,
            metadata: {
              ...metadata,
              currentOwnerId: recipientId,
              transferHistory,
              lastTransferredAt: enteredAccountAt.toISOString(),
            },
          })
          .where(eq(resources.id, tokenId));

        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "gift",
          objectId: recipientId,
          objectType: "agent",
          resourceId: tokenId,
          metadata: {
            interactionType: "thanks-token-transfer",
            targetId: recipientId,
            targetType: "person",
            thanksTokenId: tokenId,
            message: message ?? "",
          },
        } as NewLedgerEntry);

        if (contextId && isUuid(contextId)) {
          await tx.insert(ledger).values({
            verb: "comment",
            subjectId: userId,
            objectId: contextId,
            objectType: "resource",
            resourceId: contextId,
            metadata: {
              content: message || "Sent a thanks token",
              parentCommentId: null,
              isGift: true,
              giftType: "thanks",
              giftMessage: message ?? "",
              thanksTokenCount: 1,
            },
          } as NewLedgerEntry);
        }
      });

      return { success: true, message: "Thanks token sent." } as ActionResult;
    },
  );

  if (!result.success) {
    return { success: false, message: result.error ?? "Failed to send thanks token." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'resource',
    entityId: tokenId,
    actorId: userId,
    payload: { tokenId, recipientId, tokenType: 'thanks_token' },
  }).catch(() => {});

  return result.data ?? { success: true, message: "Thanks token sent." };
}

export async function sendThanksTokensAction(
  recipientId: string,
  count: number,
  message?: string,
  contextId?: string,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to send thanks tokens." };
  if (!isUuid(recipientId)) {
    return { success: false, message: "Invalid recipient id." };
  }
  if (userId === recipientId) {
    return { success: false, message: "You cannot send thanks tokens to yourself." };
  }

  const normalizedCount = Number.isFinite(count) ? Math.floor(count) : 0;
  if (normalizedCount <= 0) {
    return { success: false, message: "Choose how many thanks tokens to send." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const tokenRows = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      type: resources.type,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, userId),
        eq(resources.type, "thanks_token"),
      ),
    )
    .orderBy(resources.enteredAccountAt, resources.createdAt)
    .limit(normalizedCount);

  if (tokenRows.length < normalizedCount) {
    return {
      success: false,
      message: `You only have ${tokenRows.length} thanks token${tokenRows.length === 1 ? "" : "s"} available.`,
    };
  }

  const sentAt = new Date();

  await db.transaction(async (tx) => {
    for (const token of tokenRows) {
      const metadata = (token.metadata ?? {}) as Record<string, unknown>;
      const priorHistory = Array.isArray(metadata.transferHistory)
        ? metadata.transferHistory.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        : [];
      const transferHistory = [
        ...priorHistory,
        {
          from: userId,
          to: recipientId,
          at: sentAt.toISOString(),
          message: message ?? "",
          kind: "send",
        },
      ];

      await tx
        .update(resources)
        .set({
          ownerId: recipientId,
          enteredAccountAt: sentAt,
          metadata: {
            ...metadata,
            currentOwnerId: recipientId,
            transferHistory,
            lastTransferredAt: sentAt.toISOString(),
          },
        })
        .where(eq(resources.id, token.id));
    }

    await tx.insert(ledger).values(
      tokenRows.map((token) => ({
        subjectId: userId,
        verb: "gift",
        objectId: recipientId,
        objectType: "agent",
        resourceId: token.id,
        metadata: {
          interactionType: "thanks-token-transfer",
          targetId: recipientId,
          targetType: "person",
          thanksTokenId: token.id,
          thanksTokenCount: normalizedCount,
          message: message ?? "",
        },
      } as NewLedgerEntry)),
    );

    if (contextId && isUuid(contextId)) {
      const tokenLabel = `${normalizedCount} thanks token${normalizedCount === 1 ? "" : "s"}`;
      await tx.insert(ledger).values({
        verb: "comment",
        subjectId: userId,
        objectId: contextId,
        objectType: "resource",
        resourceId: contextId,
        metadata: {
          content: message || `Sent ${tokenLabel}`,
          parentCommentId: null,
          isGift: true,
          giftType: "thanks",
          giftMessage: message ?? "",
          thanksTokenCount: normalizedCount,
        },
      } as NewLedgerEntry);
    }
  });

  return {
    success: true,
    message: `Sent ${normalizedCount} thanks token${normalizedCount === 1 ? "" : "s"}.`,
  };
}

export async function mintThanksTokensForVoucherRedemption(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  voucherId: string,
  voucherOwnerId: string,
  redeemedBy: string,
  count: number
) {
  if (count <= 0) return;

  const mintedAt = new Date().toISOString();
  const enteredAccountAt = new Date(mintedAt);
  const values = Array.from({ length: count }, () => ({
    name: "Thanks Token",
    type: "thanks_token" as const,
    ownerId: voucherOwnerId,
    enteredAccountAt,
    description: "A gratitude token minted when a voucher is redeemed.",
    metadata: {
      entityType: "thanks_token",
      creatorId: voucherOwnerId,
      currentOwnerId: voucherOwnerId,
      sourceVoucherId: voucherId,
      mintedByClaimantId: redeemedBy,
      mintedAt,
      transferHistory: [
        {
          from: null,
          to: voucherOwnerId,
          at: mintedAt,
          kind: "mint",
          sourceVoucherId: voucherId,
          redeemedBy,
        },
      ],
    },
  }));

  await tx.insert(resources).values(values);
}
