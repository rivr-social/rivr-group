"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import {
  getCurrentUserId,
  toggleLedgerInteraction,
} from "./helpers";
import type { ActionResult, EventAttendee } from "./types";
import { isUuid } from "./types";

/**
 * Sets or clears RSVP status for an event.
 *
 * @param {string} eventId - Event identifier.
 * @param {"going" | "interested" | "none"} status - Desired RSVP state (`none` clears RSVP).
 * @returns {Promise<ActionResult>} Result including current active flag.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * await setEventRsvp("event-id", "going");
 * ```
 */
export async function setEventRsvp(
  eventId: string,
  status: "going" | "interested" | "none"
): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to RSVP." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const facadeResult = await updateFacade.execute(
    {
      type: 'setEventRsvp',
      actorId: userId,
      targetAgentId: isUuid(eventId) ? eventId : userId,
      payload: { eventId, status },
    },
    async () => {
      const existing = await db.query.ledger.findFirst({
        where: and(
          eq(ledger.subjectId, userId),
          eq(ledger.verb, "join"),
          eq(ledger.isActive, true),
          sql`${ledger.metadata}->>'interactionType' = 'rsvp'`,
          sql`${ledger.metadata}->>'targetId' = ${eventId}`
        ),
        columns: { id: true },
      });

      if (existing) {
        // Remove prior RSVP before applying a new status to keep one active RSVP per user/event.
        await db.execute(sql`
          UPDATE ledger
          SET is_active = false, expires_at = NOW()
          WHERE id = ${existing.id}
        `);
      }

      if (status === "none") {
        // Explicit "none" is treated as a clear operation after deactivating any existing RSVP.
        return { success: true, message: "RSVP removed", active: false } as ActionResult;
      }

      await db.insert(ledger).values({
        subjectId: userId,
        verb: "join",
        objectId: isUuid(eventId) ? eventId : null,
        objectType: "event",
        metadata: {
          interactionType: "rsvp",
          targetId: eventId,
          targetType: "event",
          status,
        },
      } as NewLedgerEntry);

      return { success: true, message: `RSVP set to ${status}`, active: true } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to set RSVP." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.EVENT_RSVP_CHANGED,
    entityType: 'event',
    entityId: eventId,
    actorId: userId,
    payload: { status },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: `RSVP set to ${status}` };
}

/**
 * Toggles a job application interaction for the current user.
 *
 * @param {string} jobId - Target job resource UUID.
 * @returns {Promise<ActionResult>} Interaction state result.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * await applyToJob("job-uuid");
 * ```
 */
export async function applyToJob(jobId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to apply." };
  if (!isUuid(jobId)) return { success: false, message: "Invalid job id." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const facadeResult = await updateFacade.execute(
    {
      type: 'applyToJob',
      actorId: userId,
      targetAgentId: userId,
      payload: { jobId },
    },
    async () => {
      return toggleLedgerInteraction(userId, "join", "job-application", jobId, "resource");
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to apply to job." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.EVENT_RSVP_CHANGED,
    entityType: 'resource',
    entityId: jobId,
    actorId: userId,
    payload: { action: 'job_application' },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Applied to job." };
}

/**
 * Fetches unique job IDs the current user has actively applied to.
 *
 * @param {void} _ - No input parameters.
 * @returns {Promise<string[]>} De-duplicated list of job IDs (most-recent-first source order).
 * @throws {Error} Unexpected query failures may propagate.
 * @example
 * ```ts
 * const ids = await fetchMyJobApplicationIds();
 * ```
 */
export async function fetchMyJobApplicationIds(): Promise<string[]> {
  const userId = await getCurrentUserId();
  if (!userId) return [];

  // `COALESCE` supports legacy rows where target ID may live in different columns.
  const rows = await db.execute(sql`
    SELECT COALESCE(metadata->>'targetId', object_id::text) AS job_id
    FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = 'job-application'
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  return Array.from(
    new Set(
      (rows as Array<Record<string, unknown>>)
        .map((row) => row.job_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  );
}

/**
 * Counts the number of active RSVPs for an event.
 *
 * Queries the ledger for active `join` interactions with `interactionType = 'rsvp'`
 * targeting the given event id. This matches the rows written by {@link setEventRsvp}.
 *
 * Unlike most interaction queries in this file, this function does not require
 * authentication because RSVP counts are public information displayed on event
 * detail pages for all visitors.
 *
 * @param {string} eventId - Event identifier to count RSVPs for.
 * @returns {Promise<number>} Total number of active RSVP entries for the event.
 * @throws {Error} Unexpected query failures may propagate from the database layer.
 * @example
 * ```ts
 * const count = await fetchEventRsvpCount("event-uuid");
 * // count => 42
 * ```
 */
export async function fetchEventRsvpCount(eventId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS rsvp_count
    FROM ledger
    WHERE verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = 'rsvp'
      AND metadata->>'targetId' = ${eventId}
  `);

  const first = (rows as Array<Record<string, unknown>>)[0];
  return Number(first?.rsvp_count ?? 0);
}

// EventAttendee type is exported from ./types

/**
 * Fetches the list of agents who have actively RSVP'd to an event.
 *
 * Joins the ledger against the agents table to resolve profile data for each
 * attendee. Returns at most 200 attendees ordered by RSVP timestamp (newest first).
 *
 * This is a public query -- no authentication required because attendee lists
 * are visible to all visitors on the event detail page.
 *
 * @param {string} eventId - Event identifier to fetch attendees for.
 * @returns {Promise<EventAttendee[]>} Array of attendee profiles with RSVP status.
 * @example
 * ```ts
 * const attendees = await fetchEventAttendees("event-uuid");
 * ```
 */
export async function fetchEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const MAX_ATTENDEES = 200;

  const rows = await db.execute(sql`
    SELECT
      a.id,
      a.name,
      COALESCE(a.metadata->>'username', '') AS username,
      a.image AS avatar,
      l.metadata->>'status' AS status
    FROM ledger l
    JOIN agents a ON a.id = l.subject_id
    WHERE l.verb = 'join'
      AND l.is_active = true
      AND l.metadata->>'interactionType' = 'rsvp'
      AND l.metadata->>'targetId' = ${eventId}
    ORDER BY l.timestamp DESC
    LIMIT ${MAX_ATTENDEES}
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.name ?? "Unknown"),
    username: String(row.username ?? ""),
    avatar: typeof row.avatar === "string" ? row.avatar : null,
    status: String(row.status ?? "going"),
  }));
}

/**
 * Cancels an event by setting its status to `cancelled` in the resource metadata.
 *
 * Uses `updateResource` logic inline to avoid circular import issues. Only the
 * event owner or a group admin may cancel.
 *
 * @param {string} eventId - UUID of the event resource to cancel.
 * @returns {Promise<ActionResult>} Result reflecting whether cancellation succeeded.
 * @throws {Error} Unexpected DB failures may propagate.
 * @example
 * ```ts
 * await cancelEventAction("event-uuid");
 * ```
 */
export async function cancelEventAction(eventId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to cancel an event." };
  if (!isUuid(eventId)) return { success: false, message: "Invalid event ID." };

  const check = await rateLimit(`resources-update:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [event] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(eq(resources.id, eventId))
    .limit(1);

  if (!event) return { success: false, message: "Event not found." };
  if (event.ownerId !== userId) {
    return { success: false, message: "You do not have permission to cancel this event." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: 'cancelEventAction',
      actorId: userId,
      targetAgentId: event.ownerId,
      payload: { eventId },
    },
    async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({
            metadata: sql`${resources.metadata} || '{"status":"cancelled"}'::jsonb`,
          })
          .where(eq(resources.id, eventId));

        await tx.insert(ledger).values({
          verb: "update",
          subjectId: userId,
          objectId: eventId,
          objectType: "resource",
          resourceId: eventId,
          metadata: {
            action: "cancel",
            source: "calendar-event-admin",
          },
        } as NewLedgerEntry);
      });

      revalidatePath("/");
      revalidatePath(`/events/${eventId}`);

      return { success: true, message: "Event cancelled successfully." } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to cancel event." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.EVENT_CANCELLED,
    entityType: 'resource',
    entityId: eventId,
    actorId: userId,
    payload: { eventId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Event cancelled successfully." };
}
