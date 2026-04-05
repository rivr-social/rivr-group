"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources, ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { consumeBookingSlot, isBookingSlotAvailable } from "@/lib/booking-slots";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

// =============================================================================
// Constants
// =============================================================================

const MAX_NOTES_LENGTH = 2000;

// =============================================================================
// Server Actions
// =============================================================================

/**
 * Creates a booking for an offering by consuming a time slot from the
 * offering's metadata and recording a ledger entry.
 *
 * @param input - Booking creation parameters.
 * @returns ActionResult with success/failure and optional resourceId.
 */
export async function createBookingAction(input: {
  offeringId: string;
  slotDate: string;
  slotTime: string;
  notes?: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to book." };
  if (!isUuid(input.offeringId)) return { success: false, message: "Invalid offering ID." };

  if (!input.slotDate?.trim() || !input.slotTime?.trim()) {
    return { success: false, message: "Booking date and time slot are required." };
  }

  if (input.notes && input.notes.length > MAX_NOTES_LENGTH) {
    return { success: false, message: `Notes must be ${MAX_NOTES_LENGTH} characters or fewer.` };
  }

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  try {
    const [offering] = await db
      .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
      .from(resources)
      .where(and(eq(resources.id, input.offeringId), sql`${resources.deletedAt} IS NULL`))
      .limit(1);

    if (!offering) return { success: false, message: "Offering not found." };

    const meta = (offering.metadata ?? {}) as Record<string, unknown>;
    const selection = { date: input.slotDate, slot: input.slotTime };

    if (!isBookingSlotAvailable(meta, selection)) {
      return { success: false, message: "This time slot is no longer available." };
    }

    if (offering.ownerId === userId) {
      return { success: false, message: "You cannot book your own offering." };
    }

    const facadeResult = await federatedWrite(
      {
        type: 'createBookingAction',
        actorId: userId,
        targetAgentId: offering.ownerId,
        payload: input,
      },
      async () => {
        const updatedMeta = consumeBookingSlot(meta, selection);
        const now = new Date().toISOString();

        await db.transaction(async (tx) => {
          await tx
            .update(resources)
            .set({ metadata: updatedMeta })
            .where(eq(resources.id, input.offeringId));

          await tx.insert(ledger).values({
            subjectId: userId,
            verb: "schedule",
            objectId: input.offeringId,
            objectType: "resource",
            resourceId: input.offeringId,
            isActive: true,
            metadata: {
              interactionType: "booking",
              targetId: input.offeringId,
              targetType: "resource",
              slotDate: input.slotDate,
              slotTime: input.slotTime,
              notes: input.notes?.trim() ?? null,
              bookingStatus: "confirmed",
              bookedAt: now,
              sellerId: offering.ownerId,
            },
          } as NewLedgerEntry);
        });

        revalidatePath("/");
        revalidatePath(`/marketplace/${input.offeringId}`);
        return { success: true, message: "Booking confirmed." } as ActionResult;
      },
    );

    if (!facadeResult.success) {
      return { success: false, message: facadeResult.error ?? "Failed to create booking." };
    }

    emitDomainEvent({
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      entityType: 'resource',
      entityId: input.offeringId,
      actorId: userId,
      payload: { offeringId: input.offeringId, slotDate: input.slotDate, slotTime: input.slotTime },
    }).catch(() => {});

    return facadeResult.data ?? { success: true, message: "Booking confirmed." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create booking.";
    console.error("[createBookingAction] failed:", error);
    return { success: false, message };
  }
}

/**
 * Fetches all active bookings for a given offering.
 *
 * @param offeringId - The offering resource UUID.
 * @returns ActionResult with a bookings array in the message or error.
 */
export async function getOfferingBookingsAction(offeringId: string): Promise<{
  success: boolean;
  message: string;
  bookings: Array<{
    id: string;
    userId: string;
    slotDate: string;
    slotTime: string;
    notes: string | null;
    status: string;
    bookedAt: string;
  }>;
}> {
  if (!isUuid(offeringId)) {
    return { success: false, message: "Invalid offering ID.", bookings: [] };
  }

  try {
    const rows = await db
      .select({
        id: ledger.id,
        subjectId: ledger.subjectId,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
      })
      .from(ledger)
      .where(
        and(
          eq(ledger.objectId, offeringId),
          eq(ledger.verb, "schedule"),
          eq(ledger.isActive, true),
          sql`${ledger.metadata}->>'interactionType' = 'booking'`,
        )
      )
      .orderBy(ledger.timestamp);

    const bookings = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        userId: row.subjectId,
        slotDate: String(meta.slotDate ?? ""),
        slotTime: String(meta.slotTime ?? ""),
        notes: typeof meta.notes === "string" ? meta.notes : null,
        status: String(meta.bookingStatus ?? "confirmed"),
        bookedAt: row.timestamp.toISOString(),
      };
    });

    return { success: true, message: "Bookings loaded.", bookings };
  } catch (error) {
    console.error("[getOfferingBookingsAction] failed:", error);
    return { success: false, message: "Failed to load bookings.", bookings: [] };
  }
}
