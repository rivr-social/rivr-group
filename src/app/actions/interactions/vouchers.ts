"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { consumeBookingSlot, hasBookableSchedule, isBookingSlotAvailable, type BookingSelection } from "@/lib/booking-slots";
import { emitDomainEvent, EVENT_TYPES, federatedWrite } from "@/lib/federation";
import {
  getCurrentUserId,
} from "./helpers";
import type { ActionResult, VoucherEscrowState } from "./types";
import { isUuid } from "./types";

const VOUCHER_ESCROW_AGENT_NAME = "RIVR Voucher Escrow";

async function getVoucherEscrowAgentId(tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db): Promise<string> {
  const [existing] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.type, "system"),
        eq(agents.name, VOUCHER_ESCROW_AGENT_NAME),
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await tx
    .insert(agents)
    .values({
      name: VOUCHER_ESCROW_AGENT_NAME,
      type: "system",
      visibility: "private",
      metadata: {
        entityType: "system",
        role: "voucher_escrow",
      },
    })
    .returning({ id: agents.id });

  return created.id;
}

async function countActiveThanksTokensForOwner(
  ownerId: string,
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        eq(resources.type, "thanks_token"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    );

  return Number(row?.count ?? 0);
}

async function getActiveVoucherEscrowClaim(
  voucherId: string,
  claimantId?: string | null,
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
) {
  const conditions = [
    eq(ledger.verb, "join"),
    eq(ledger.objectId, voucherId),
    eq(ledger.isActive, true),
    sql`${ledger.metadata}->>'interactionType' = 'voucher-escrow-claim'`,
  ];

  if (claimantId) {
    conditions.push(eq(ledger.subjectId, claimantId));
  }

  return tx.query.ledger.findFirst({
    where: and(...conditions),
    columns: {
      id: true,
      subjectId: true,
      metadata: true,
    },
  });
}

function getVoucherThanksTokenCount(metadata: Record<string, unknown>): number {
  const voucherValues =
    metadata.voucherValues && typeof metadata.voucherValues === "object" && !Array.isArray(metadata.voucherValues)
      ? (metadata.voucherValues as Record<string, unknown>)
      : null;

  const thanksValue =
    typeof voucherValues?.thanksValue === "number"
      ? voucherValues.thanksValue
      : typeof metadata.thanksValue === "number"
        ? metadata.thanksValue
        : 1;

  return Math.max(0, Math.floor(thanksValue));
}

/**
 * Sends a voucher gift interaction from the current user to a recipient.
 *
 * @param {string} voucherId - Voucher resource UUID.
 * @param {string} recipientId - Recipient agent UUID.
 * @param {string} [message] - Optional gift message persisted in metadata.
 * @returns {Promise<ActionResult>} Result status for the gift operation.
 * @throws {Error} Unexpected insert failures may propagate.
 * @example
 * ```ts
 * await sendVoucherAction("voucher-uuid", "recipient-uuid", "Thanks for helping!");
 * ```
 */
export async function sendVoucherAction(
  voucherId: string,
  recipientId: string,
  message?: string,
  contextId?: string,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to send a voucher." };
  if (!isUuid(voucherId) || !isUuid(recipientId)) {
    return { success: false, message: "Invalid voucher or recipient id." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const result = await federatedWrite(
    {
      type: 'sendVoucherAction',
      actorId: userId,
      targetAgentId: recipientId,
      payload: { voucherId, recipientId, message, contextId },
    },
    async () => {
      const [voucher] = await db
        .select({ id: resources.id, name: resources.name, type: resources.type })
        .from(resources)
        .where(eq(resources.id, voucherId))
        .limit(1);

      const voucherName = voucher?.name ?? "Voucher";

      await db.transaction(async (tx) => {
        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "gift",
          objectId: recipientId,
          objectType: "agent",
          resourceId: voucherId,
          metadata: {
            interactionType: "voucher-gift",
            targetId: recipientId,
            targetType: "person",
            voucherId,
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
              content: message || `Gifted a voucher: ${voucherName}`,
              parentCommentId: null,
              isGift: true,
              giftType: "voucher",
              giftMessage: message ?? "",
              voucherId,
              voucherName,
            },
          } as NewLedgerEntry);
        }
      });

      return { success: true, message: "Voucher sent." } as ActionResult;
    },
  );

  if (!result.success) {
    return { success: false, message: result.error ?? "Failed to send voucher." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: voucherId,
    actorId: userId,
    payload: { action: 'send', recipientId },
  }).catch(() => {});

  return result.data ?? { success: true, message: "Voucher sent." };
}

export async function fetchVoucherEscrowStateAction(voucherId: string): Promise<VoucherEscrowState | null> {
  if (!isUuid(voucherId)) return null;

  const userId = await getCurrentUserId();
  const [voucher] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata, type: resources.type })
    .from(resources)
    .where(eq(resources.id, voucherId))
    .limit(1);

  const vMeta = (voucher?.metadata ?? {}) as Record<string, unknown>;
  if (!voucher || !(voucher.type === "voucher" || vMeta.offeringType === "voucher" || vMeta.listingType === "voucher")) return null;

  const metadata = (voucher.metadata ?? {}) as Record<string, unknown>;
  const status = String(metadata.status ?? "available");
  const requiredThanks = getVoucherThanksTokenCount(metadata);
  const availableThanks = userId ? await countActiveThanksTokensForOwner(userId) : 0;
  const claim = userId ? await getActiveVoucherEscrowClaim(voucherId, userId) : null;
  const claimantId =
    typeof metadata.claimedBy === "string"
      ? metadata.claimedBy
      : claim?.subjectId ?? null;

  const claimMeta = (claim?.metadata ?? {}) as Record<string, unknown>;
  const escrowedTokenIds = Array.isArray(claimMeta.escrowTokenIds)
    ? claimMeta.escrowTokenIds.filter((value): value is string => typeof value === "string")
    : [];

  return {
    voucherId,
    status,
    requiredThanks,
    availableThanks,
    hasEscrowClaim: Boolean(claim),
    canClaim: Boolean(userId) && status === "available" && voucher.ownerId !== userId && !claim && requiredThanks > 0 && availableThanks >= requiredThanks,
    canRedeem: Boolean(userId) && status !== "completed" && Boolean(claim),
    claimedAt:
      typeof claimMeta.claimedAt === "string"
        ? claimMeta.claimedAt
        : typeof metadata.claimedAt === "string"
          ? metadata.claimedAt
          : null,
    claimedBookingDate:
      typeof claimMeta.bookingDate === "string"
        ? claimMeta.bookingDate
        : typeof metadata.claimedBookingDate === "string"
          ? metadata.claimedBookingDate
          : null,
    claimedBookingSlot:
      typeof claimMeta.bookingSlot === "string"
        ? claimMeta.bookingSlot
        : typeof metadata.claimedBookingSlot === "string"
          ? metadata.claimedBookingSlot
          : null,
    escrowedTokenCount: escrowedTokenIds.length,
    claimantId,
    isOwner: voucher.ownerId === userId,
  };
}

/**
 * Creates a voucher resource in the current user's name scoped to a group/ring.
 *
 * Writes the voucher as a `voucher` type resource and records the creation in
 * the ledger. The group ID is stored in the resource tags so it is visible
 * to `fetchVouchersForGroup`.
 *
 * @param {{
 *   title: string;
 *   description: string;
 *   category: string;
 *   ringId: string;
 *   estimatedValue?: number;
 *   timeCommitment?: string;
 *   location?: string;
 *   maxClaims?: number;
 * }} input - Voucher fields plus ring scoping.
 * @returns {Promise<ActionResult>} Result with the new resource ID on success.
 * @throws {Error} Unexpected DB failures may propagate.
 * @example
 * ```ts
 * await createVoucherAction({ title: "Help with moving", description: "...", category: "service", ringId: "ring-uuid" });
 * ```
 */
export async function createVoucherAction(input: {
  title: string;
  description: string;
  category: string;
  ringId: string;
  ownerId?: string;
  scopedLocaleIds?: string[];
  postToFeed?: boolean;
  estimatedValue?: number;
  timeCommitment?: string;
  location?: string;
  maxClaims?: number;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to create a voucher." };

  if (!isUuid(input.ringId)) return { success: false, message: "Invalid ring ID." };
  if (!input.title?.trim()) return { success: false, message: "Voucher title is required." };
  if (!input.description?.trim()) return { success: false, message: "Voucher description is required." };

  const [targetRing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.ringId))
    .limit(1);

  if (!targetRing) return { success: false, message: "Ring not found." };

  const ownerId = input.ownerId ?? userId;
  if (ownerId !== userId) {
    const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
    const allowed = await hasGroupWriteAccess(userId, ownerId);
    if (!allowed) {
      return { success: false, message: "You do not have permission to create a voucher for this group." };
    }
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const result = await federatedWrite(
    {
      type: 'createVoucherAction',
      actorId: userId,
      targetAgentId: ownerId,
      payload: input,
    },
    async () => {
      const [created] = await db
        .insert(resources)
        .values({
          name: input.title.trim(),
          type: "voucher",
          description: input.description.trim(),
          content: input.description.trim(),
          ownerId,
          visibility: "members",
          tags: [input.ringId],
          metadata: {
            entityType: "voucher",
            resourceKind: "voucher",
            ringId: input.ringId,
            groupId: input.ringId,
            groupTags: [input.ringId],
            chapterTags: input.scopedLocaleIds ?? [],
            category: input.category,
            status: "available",
            estimatedValue: input.estimatedValue ?? 0,
            timeCommitment: input.timeCommitment ?? null,
            location: input.location ?? null,
            maxClaims: input.maxClaims ?? 1,
            currentClaims: 0,
          },
        } as NewResource)
        .returning({ id: resources.id });

      await db.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: created.id,
        objectType: "resource",
        resourceId: created.id,
        metadata: {
          resourceType: "voucher",
          ringId: input.ringId,
          source: "voucher-pool-tab",
        },
      } as NewLedgerEntry);

      if (input.postToFeed) {
        const { createPostResource } = await import("@/app/actions/create-resources");
        await createPostResource({
          content: input.description.trim(),
          postType: "offer",
          groupId: input.ringId,
          linkedOfferingId: created.id,
          scopedLocaleIds: input.scopedLocaleIds,
          scopedGroupIds: [input.ringId],
          isGlobal: false,
        });
      }

      revalidatePath("/");
      revalidatePath(`/rings/${input.ringId}`);
      return { success: true, message: "Voucher created successfully.", resourceId: created.id } as ActionResult;
    },
  );

  if (!result.success) {
    return { success: false, message: result.error ?? "Failed to create voucher." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: 'resource',
    entityId: result.data?.resourceId ?? '',
    actorId: userId,
    payload: { resourceType: 'voucher', ringId: input.ringId },
  }).catch(() => {});

  return result.data ?? { success: true, message: "Voucher created successfully." };
}

/**
 * Claims a voucher by recording a ledger entry and incrementing the claim count.
 *
 * Checks that the voucher is still available and below its max-claims limit before
 * writing the claim. The claim is stored as a `join`/`voucher-claim` ledger edge,
 * and the resource metadata is updated with the new claim count.
 *
 * @param {string} voucherId - UUID of the voucher resource to claim.
 * @returns {Promise<ActionResult>} Result reflecting whether the claim succeeded.
 * @throws {Error} Unexpected DB failures may propagate.
 * @example
 * ```ts
 * await claimVoucherAction("voucher-uuid");
 * ```
 */
export async function claimVoucherAction(voucherId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to claim a voucher." };
  if (!isUuid(voucherId)) return { success: false, message: "Invalid voucher ID." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const result = await federatedWrite(
    {
      type: 'claimVoucherAction',
      actorId: userId,
      targetAgentId: userId,
      payload: { voucherId },
    },
    async () => {
      await db.transaction(async (tx) => {
        // Lock the resource row to prevent concurrent claim races
        const [lockedVoucher] = await tx
          .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
          .from(resources)
          .where(eq(resources.id, voucherId))
          .for('update')
          .limit(1);

        if (!lockedVoucher) throw new Error("Voucher not found.");
        if (lockedVoucher.ownerId === userId) throw new Error("You cannot claim your own voucher.");

        const meta = (lockedVoucher.metadata ?? {}) as Record<string, unknown>;
        const currentClaims = Number(meta.currentClaims ?? 0);
        const maxClaims = Number(meta.maxClaims ?? 1);
        const status = String(meta.status ?? "available");

        if (status !== "available") throw new Error("This voucher is no longer available.");
        if (currentClaims >= maxClaims) throw new Error("This voucher has reached its maximum number of claims.");

        const newClaims = currentClaims + 1;
        const newStatus = newClaims >= maxClaims ? "claimed" : "available";
        const now = new Date().toISOString();

        await tx
          .update(resources)
          .set({
            metadata: sql`${resources.metadata} || ${JSON.stringify({
              currentClaims: newClaims,
              status: newStatus,
              claimedBy: userId,
              claimedAt: now,
            })}::jsonb`,
          })
          .where(eq(resources.id, voucherId));

        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "join",
          objectId: voucherId,
          objectType: "resource",
          resourceId: voucherId,
          metadata: {
            interactionType: "voucher-claim",
            targetId: voucherId,
            targetType: "resource",
            claimedAt: now,
          },
        } as NewLedgerEntry);
      });

      revalidatePath("/");
      return { success: true, message: "Voucher claimed successfully." } as ActionResult;
    },
  );

  if (!result.success) {
    return { success: false, message: result.error ?? "Failed to claim voucher." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: voucherId,
    actorId: userId,
    payload: { action: 'claim' },
  }).catch(() => {});

  return result.data ?? { success: true, message: "Voucher claimed successfully." };
}

export async function claimVoucherWithThanksEscrowAction(
  voucherId: string,
  bookingSelection?: BookingSelection | null,
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to claim a voucher." };
  if (!isUuid(voucherId)) return { success: false, message: "Invalid voucher ID." };

  const check = await rateLimit(`wallet:${userId}`, RATE_LIMITS.WALLET.limit, RATE_LIMITS.WALLET.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [voucher] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata, type: resources.type })
    .from(resources)
    .where(eq(resources.id, voucherId))
    .limit(1);

  const voucherMeta = (voucher?.metadata ?? {}) as Record<string, unknown>;
  const isVoucher = voucher?.type === "voucher" || voucherMeta.offeringType === "voucher" || voucherMeta.listingType === "voucher";
  if (!voucher || !isVoucher) return { success: false, message: "Voucher not found." };
  if (voucher.ownerId === userId) return { success: false, message: "You cannot claim your own voucher." };

  const meta = (voucher.metadata ?? {}) as Record<string, unknown>;
  const requiredThanks = getVoucherThanksTokenCount(meta);

  if (requiredThanks <= 0) {
    return claimVoucherAction(voucherId);
  }

  const status = String(meta.status ?? "available");
  if (status === "completed") return { success: false, message: "This voucher has already been redeemed." };

  const existingClaim = await getActiveVoucherEscrowClaim(voucherId, userId);
  if (existingClaim) {
    return { success: true, message: "Voucher already claimed and funded in escrow." };
  }

  const now = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      const escrowAgentId = await getVoucherEscrowAgentId(tx);

      const [lockedVoucher] = await tx
        .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata, type: resources.type })
        .from(resources)
        .where(eq(resources.id, voucherId))
        .limit(1);

      const lockedMeta2 = (lockedVoucher?.metadata ?? {}) as Record<string, unknown>;
      if (!lockedVoucher || !(lockedVoucher.type === "voucher" || lockedMeta2.offeringType === "voucher" || lockedMeta2.listingType === "voucher")) {
        throw new Error("Voucher not found.");
      }

      const lockedMeta = (lockedVoucher.metadata ?? {}) as Record<string, unknown>;
      const currentClaims = Number(lockedMeta.currentClaims ?? 0);
      const maxClaims = Number(lockedMeta.maxClaims ?? 1);
      if (currentClaims >= maxClaims) {
        throw new Error("This voucher has reached its maximum number of claims.");
      }
      if (hasBookableSchedule(lockedMeta) && !bookingSelection) {
        throw new Error("Select a booking block before claiming this voucher.");
      }
      if (!isBookingSlotAvailable(lockedMeta, bookingSelection)) {
        throw new Error("Selected booking block is no longer available.");
      }

      const tokenRows = await tx
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.ownerId, userId),
            eq(resources.type, "thanks_token"),
            sql`${resources.deletedAt} IS NULL`,
          ),
        )
        .orderBy(resources.enteredAccountAt, resources.createdAt)
        .limit(requiredThanks);

      if (tokenRows.length < requiredThanks) {
        throw new Error(`You need ${requiredThanks} Thanks to claim this voucher.`);
      }

      const escrowTokenIds = tokenRows.map((row) => row.id);

      await tx
        .update(resources)
        .set({
          ownerId: escrowAgentId,
          enteredAccountAt: new Date(),
          metadata: sql`${resources.metadata} || ${JSON.stringify({
            currentOwnerId: escrowAgentId,
            escrowVoucherId: voucherId,
            escrowedFromAgentId: userId,
            escrowedAt: now,
          })}::jsonb`,
        })
        .where(inArray(resources.id, escrowTokenIds));

      const newClaims = currentClaims + 1;
      await tx
        .update(resources)
        .set({
          metadata: {
            ...consumeBookingSlot(lockedMeta, bookingSelection),
            currentClaims: newClaims,
            status: "claimed",
            claimedBy: userId,
            claimedAt: now,
            escrowedThanks: requiredThanks,
            claimedBookingDate: bookingSelection?.date ?? null,
            claimedBookingSlot: bookingSelection?.slot ?? null,
          },
        })
        .where(eq(resources.id, voucherId));

      await tx.insert(ledger).values({
        subjectId: userId,
        verb: "join",
        objectId: voucherId,
        objectType: "resource",
        resourceId: voucherId,
        metadata: {
          interactionType: "voucher-escrow-claim",
          targetId: voucherId,
          targetType: "resource",
          claimedAt: now,
          thanksTokenCount: requiredThanks,
          escrowTokenIds,
          escrowAgentId,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
        },
      } as NewLedgerEntry);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to escrow Thanks for this voucher.";
    return { success: false, message };
  }

  revalidatePath("/");
  revalidatePath(`/marketplace/${voucherId}`);
  revalidatePath(`/marketplace/${voucherId}/purchase`);
  return { success: true, message: `Claimed voucher and escrowed ${requiredThanks} Thanks.` };
}

export async function redeemVoucherAction(voucherId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to redeem a voucher." };
  if (!isUuid(voucherId)) return { success: false, message: "Invalid voucher ID." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [voucher] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata, type: resources.type })
    .from(resources)
    .where(eq(resources.id, voucherId))
    .limit(1);

  const rMeta = (voucher?.metadata ?? {}) as Record<string, unknown>;
  if (!voucher || !(voucher.type === "voucher" || rMeta.offeringType === "voucher" || rMeta.listingType === "voucher")) return { success: false, message: "Voucher not found." };

  const meta = (voucher.metadata ?? {}) as Record<string, unknown>;
  const status = String(meta.status ?? "available");
  const claimedBy = typeof meta.claimedBy === "string" ? meta.claimedBy : null;

  if (status === "completed") return { success: false, message: "This voucher has already been redeemed." };
  if (claimedBy && claimedBy !== userId) {
    return { success: false, message: "Only the claimant can redeem this voucher." };
  }

  const redeemedAt = new Date().toISOString();
  const thanksTokenCount = getVoucherThanksTokenCount(meta);

  const result = await federatedWrite(
    {
      type: 'redeemVoucherAction',
      actorId: userId,
      targetAgentId: userId,
      payload: { voucherId },
    },
    async () => {
      await db.transaction(async (tx) => {
        const activeClaim = await getActiveVoucherEscrowClaim(voucherId, claimedBy ?? userId, tx);
        const claimMeta = (activeClaim?.metadata ?? {}) as Record<string, unknown>;
        const escrowTokenIds = Array.isArray(claimMeta.escrowTokenIds)
          ? claimMeta.escrowTokenIds.filter((value): value is string => typeof value === "string")
          : [];

        if (thanksTokenCount > 0 && escrowTokenIds.length < thanksTokenCount) {
          throw new Error("Voucher escrow is incomplete.");
        }

        await tx
          .update(resources)
          .set({
            metadata: {
              ...meta,
              status: "completed",
              redeemedBy: userId,
              redeemedAt,
              completedAt: redeemedAt,
              claimedBy: claimedBy ?? userId,
              claimedAt: typeof meta.claimedAt === "string" ? meta.claimedAt : redeemedAt,
            },
          })
          .where(eq(resources.id, voucherId));

        if (escrowTokenIds.length > 0) {
          // Transfer token ownership from escrow to voucher owner
          await tx
            .update(resources)
            .set({
              ownerId: voucher.ownerId ?? userId,
              enteredAccountAt: new Date(),
              metadata: sql`${resources.metadata} || ${JSON.stringify({
                currentOwnerId: voucher.ownerId ?? userId,
                releasedFromEscrowAt: redeemedAt,
                sourceVoucherId: voucherId,
              })}::jsonb`,
            })
            .where(inArray(resources.id, escrowTokenIds));

          // Record the thanks token transfer so wallet counts update
          await tx.insert(ledger).values({
            subjectId: userId,
            verb: "gift",
            objectId: voucher.ownerId ?? userId,
            objectType: "agent",
            isActive: true,
            metadata: {
              interactionType: "thanks-token-transfer",
              targetId: voucher.ownerId ?? userId,
              targetType: "agent",
              count: escrowTokenIds.length,
              tokenCount: escrowTokenIds.length,
              tokenIds: escrowTokenIds,
              sourceVoucherId: voucherId,
              transferredAt: redeemedAt,
            },
          } as NewLedgerEntry);
        }

        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "redeem",
          objectId: voucherId,
          objectType: "resource",
          resourceId: voucherId,
          metadata: {
            interactionType: "voucher-redemption",
            targetId: voucherId,
            targetType: "resource",
            redeemedAt,
            thanksTokenCount,
            escrowTokenIds,
          },
        } as NewLedgerEntry);

        if (activeClaim) {
          await tx
            .update(ledger)
            .set({
              isActive: false,
              expiresAt: new Date(),
              metadata: {
                ...claimMeta,
                status: "redeemed",
                redeemedAt,
              },
            })
            .where(eq(ledger.id, activeClaim.id));
        }
      });

      revalidatePath("/");
      revalidatePath(`/marketplace/${voucherId}`);
      return {
        success: true,
        message: `Voucher redeemed successfully.${thanksTokenCount > 0 ? ` Released ${thanksTokenCount} escrowed Thanks to the offerer.` : ""}`,
      } as ActionResult;
    },
  );

  if (!result.success) {
    return { success: false, message: result.error ?? "Unable to redeem voucher." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: 'resource',
    entityId: voucherId,
    actorId: userId,
    payload: { action: 'redeem', thanksTokenCount },
  }).catch(() => {});

  return result.data ?? { success: true, message: "Voucher redeemed successfully." };
}
