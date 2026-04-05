"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources, ledger } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES, federatedWrite } from "@/lib/federation";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

// =============================================================================
// Constants
// =============================================================================

const VALID_CATEGORIES = ["vehicle", "tool", "equipment", "property", "technology", "other"] as const;
const DEFAULT_CATEGORY = "other";

// =============================================================================
// Server Actions
// =============================================================================

/**
 * Creates a new mutual asset resource owned by the specified ring.
 *
 * Auth requirement: caller must be authenticated.
 * Rate limiting: keyed by user ID using the SOCIAL rate limit bucket.
 *
 * @param params - Asset creation parameters.
 * @returns ActionResult with success/failure and optional resourceId.
 */
export async function createMutualAssetAction(params: {
  name: string;
  description: string;
  category?: string;
  ringId: string;
  value?: number;
  location?: string;
  usageInstructions?: string;
  tags?: string[];
  restrictions?: string[];
  bookingRequired?: boolean;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to add an asset." };
  if (!isUuid(params.ringId)) return { success: false, message: "Invalid ring ID." };

  if (!params.name || !params.name.trim()) {
    return { success: false, message: "Asset name is required." };
  }
  if (!params.description || !params.description.trim()) {
    return { success: false, message: "Asset description is required." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const category = VALID_CATEGORIES.includes(params.category as typeof VALID_CATEGORIES[number])
    ? params.category
    : DEFAULT_CATEGORY;

  const facadeResult = await federatedWrite(
    {
      type: 'createMutualAssetAction',
      actorId: userId,
      targetAgentId: params.ringId,
      payload: params,
    },
    async () => {
      const now = new Date().toISOString();

      const [created] = await db
        .insert(resources)
        .values({
          name: params.name.trim(),
          type: "asset",
          description: params.description.trim(),
          ownerId: params.ringId,
          visibility: "members",
          tags: params.tags ?? [],
          metadata: {
            entityType: "mutual_asset",
            category,
            status: "available",
            assetValue: params.value,
            location: params.location,
            usageInstructions: params.usageInstructions,
            restrictions: params.restrictions ?? [],
            bookingRequired: params.bookingRequired ?? false,
            contributedBy: userId,
            addedAt: now,
          },
        } as NewResource)
        .returning({ id: resources.id });

      // Record a ledger entry for the asset contribution
      await db.insert(ledger).values({
        subjectId: userId,
        verb: "create",
        objectId: params.ringId,
        objectType: "agent",
        resourceId: created.id,
        metadata: {
          interactionType: "asset-contribution",
          targetId: params.ringId,
          targetType: "ring",
          assetId: created.id,
          assetName: params.name.trim(),
          createdAt: now,
        },
      } as NewLedgerEntry);

      revalidatePath("/");
      return { success: true, message: "Asset added successfully.", resourceId: created.id } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to create asset." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: 'resource',
    entityId: facadeResult.data?.resourceId ?? '',
    actorId: userId,
    payload: { resourceType: 'asset', ringId: params.ringId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Asset added successfully." };
}

/**
 * Books/requests usage of a mutual asset by creating a ledger entry.
 *
 * Auth requirement: caller must be authenticated.
 * Rate limiting: keyed by user ID using the SOCIAL rate limit bucket.
 *
 * @param params - Booking request parameters.
 * @returns ActionResult with success/failure.
 */
export async function bookAssetAction(params: {
  assetId: string;
  startDate: string;
  endDate: string;
  purpose: string;
  notes?: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to book an asset." };
  if (!isUuid(params.assetId)) return { success: false, message: "Invalid asset ID." };

  if (!params.startDate || !params.endDate) {
    return { success: false, message: "Start and end dates are required." };
  }
  if (!params.purpose || !params.purpose.trim()) {
    return { success: false, message: "Purpose is required." };
  }
  if (new Date(params.startDate) >= new Date(params.endDate)) {
    return { success: false, message: "End date must be after start date." };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  try {
    // Verify the asset exists and is available
    const [asset] = await db
      .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
      .from(resources)
      .where(eq(resources.id, params.assetId))
      .limit(1);

    if (!asset) return { success: false, message: "Asset not found." };

    const meta = (asset.metadata ?? {}) as Record<string, unknown>;
    const status = String(meta.status ?? "available");

    if (status !== "available") {
      return { success: false, message: `Asset is currently ${status} and cannot be booked.` };
    }

    const facadeResult = await federatedWrite(
      {
        type: 'bookAssetAction',
        actorId: userId,
        targetAgentId: asset.ownerId,
        payload: params,
      },
      async () => {
        const now = new Date().toISOString();

        // Create a booking ledger entry
        await db.insert(ledger).values({
          subjectId: userId,
          verb: "request",
          objectId: params.assetId,
          objectType: "resource",
          resourceId: params.assetId,
          isActive: true,
          metadata: {
            interactionType: "asset-booking",
            targetId: params.assetId,
            targetType: "resource",
            startDate: params.startDate,
            endDate: params.endDate,
            purpose: params.purpose.trim(),
            notes: params.notes?.trim() ?? null,
            bookingStatus: "pending",
            requestedAt: now,
          },
        } as NewLedgerEntry);

        // Update asset status to reserved
        await db
          .update(resources)
          .set({
            metadata: sql`${resources.metadata} || ${JSON.stringify({
              status: "reserved",
              currentUserId: userId,
              currentUseStartDate: params.startDate,
              currentUseEndDate: params.endDate,
            })}::jsonb`,
          })
          .where(eq(resources.id, params.assetId));

        revalidatePath("/");
        return { success: true, message: "Booking request submitted successfully." } as ActionResult;
      },
    );

    if (!facadeResult.success) {
      return { success: false, message: facadeResult.error ?? "Failed to submit booking request." };
    }

    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      entityType: 'resource',
      entityId: params.assetId,
      actorId: userId,
      payload: { assetId: params.assetId, action: 'book' },
    }).catch(() => {});

    return facadeResult.data ?? { success: true, message: "Booking request submitted successfully." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit booking request.";
    return { success: false, message };
  }
}
