/**
 * System-lane transcript landing for Virtual Meetings.
 *
 * The LiveKit webhook processor has NO user session (it is machine-
 * authenticated by LiveKit's signed JWT), so it cannot go through the
 * session-gated document actions. This module lands the merged meeting
 * transcript with direct DB writes, mirroring the exact document shape
 * `ensureEventTranscriptDocument` produces (type 'document', subtype
 * 'event-transcript', metadata.eventId) so every existing read surface
 * (getEventTranscriptDocument, the event transcript panel) renders it.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";

export interface TranscriptEventContext {
  eventId: string;
  eventName: string;
  /** The group whose meeting this is (event metadata.groupId → ownerId). */
  groupId: string;
  eventMetadata: Record<string, unknown>;
}

/** Loads the event row and resolves its transcript context; null if gone. */
export async function loadTranscriptEventContext(
  eventId: string,
): Promise<TranscriptEventContext | null> {
  const [event] = await db
    .select({
      id: resources.id,
      name: resources.name,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, eventId),
        eq(resources.type, "event"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!event) return null;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const groupId =
    typeof metadata.groupId === "string" && metadata.groupId.trim()
      ? metadata.groupId
      : event.ownerId;

  return {
    eventId: event.id,
    eventName: event.name,
    groupId,
    eventMetadata: metadata,
  };
}

async function findTranscriptDocument(eventId: string) {
  const [doc] = await db
    .select({
      id: resources.id,
      content: resources.content,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.type, "document"),
        sql`${resources.deletedAt} IS NULL`,
        sql`${resources.metadata}->>'resourceSubtype' = 'event-transcript'`,
        sql`${resources.metadata}->>'eventId' = ${eventId}`,
      ),
    )
    .orderBy(sql`${resources.updatedAt} DESC`)
    .limit(1);
  return doc ?? null;
}

/**
 * Appends a markdown section to the event's transcript document (creating
 * the document if none exists) and stamps the event metadata pointers.
 * Returns the transcript document id.
 */
export async function landMeetingTranscriptSection(
  context: TranscriptEventContext,
  markdownSection: string,
  contributorIds: string[],
): Promise<string> {
  const now = new Date();
  const existing = await findTranscriptDocument(context.eventId);

  let documentId: string;
  if (existing) {
    const docMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
    const priorContributors = Array.isArray(docMetadata.transcriptContributorIds)
      ? (docMetadata.transcriptContributorIds as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const mergedContributors = Array.from(
      new Set([...priorContributors, ...contributorIds]),
    );

    await db
      .update(resources)
      .set({
        content: `${existing.content ?? ""}\n\n${markdownSection}`,
        metadata: {
          ...docMetadata,
          transcriptUpdatedAt: now.toISOString(),
          transcriptContributorIds: mergedContributors,
          eventId: context.eventId,
        },
        updatedAt: now,
      })
      .where(eq(resources.id, existing.id));
    documentId = existing.id;
  } else {
    const title = `${context.eventName} Transcript`;
    const [created] = await db
      .insert(resources)
      .values({
        name: title,
        type: "document",
        description: `Meeting transcript for ${context.eventName}.`,
        content: `# ${title}\n\n${markdownSection}`,
        ownerId: context.groupId,
        visibility: "members",
        tags: ["meeting", "transcript", context.eventId],
        metadata: {
          resourceSubtype: "event-transcript",
          eventId: context.eventId,
          groupId: context.groupId,
          category: "meeting-transcript",
          transcriptUpdatedAt: now.toISOString(),
          transcriptContributorIds: contributorIds,
          linkedPostId:
            typeof context.eventMetadata.linkedPostId === "string"
              ? context.eventMetadata.linkedPostId
              : null,
        },
      })
      .returning({ id: resources.id });
    documentId = created.id;

    // Provenance edge: the group agent authored this system document.
    await db.insert(ledger).values({
      subjectId: context.groupId,
      verb: "create",
      objectId: documentId,
      objectType: "resource",
      metadata: {
        interactionType: "resource-creation",
        system: "virtual-meeting-transcript",
        eventId: context.eventId,
      },
    } as NewLedgerEntry);
  }

  // Stamp the event so the detail page finds the transcript immediately.
  await db
    .update(resources)
    .set({
      metadata: {
        ...context.eventMetadata,
        transcriptDocumentId: documentId,
        transcriptionEnabled: true,
      },
      updatedAt: now,
    })
    .where(eq(resources.id, context.eventId));

  return documentId;
}

/** Patches ONLY the given metadata keys on the event row (fresh-read merge). */
export async function patchEventMetadata(
  eventId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const [event] = await db
    .select({ metadata: resources.metadata })
    .from(resources)
    .where(eq(resources.id, eventId))
    .limit(1);
  if (!event) return;

  await db
    .update(resources)
    .set({
      metadata: { ...((event.metadata ?? {}) as Record<string, unknown>), ...patch },
      updatedAt: new Date(),
    })
    .where(eq(resources.id, eventId));
}
