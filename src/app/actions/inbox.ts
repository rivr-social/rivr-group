"use server";

/**
 * Server actions for notification display and read-state management.
 *
 * Purpose:
 * - Query notification entries from ledger for the current user.
 * - Persist read/unread markers for individual or bulk notifications.
 *
 * Note: Direct messaging has been migrated to Matrix/Synapse.
 * DM functions (fetchInboxData, sendDirectMessage, markConversationAsRead)
 * and their associated types have been removed.
 *
 * Key exports:
 * - `fetchNotifications` — notification entries targeting the current user.
 * - `fetchNotificationReadState` — read/unread state for notification ids.
 * - `setNotificationReadState` — toggle read state for a single notification.
 * - `markAllNotificationsAsRead` — bulk mark notifications as read.
 *
 * Dependencies:
 * - `auth` for actor identity.
 * - `db` with `ledger` and `agents` tables for read/write activity records.
 * - `revalidatePath` for cache invalidation after read-state writes.
 */
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";

type Metadata = Record<string, unknown>;

export type SerializedNotification = {
  id: string;
  type: string;
  actorId: string;
  actorName: string;
  actorUsername?: string | null;
  actorImage: string | null;
  targetId: string | null;
  message: string;
  timestamp: string;
};

function parseMeta(meta: unknown): Metadata {
  if (!meta || typeof meta !== "object") return {};
  return meta as Metadata;
}

/**
 * Fetches notification entries targeting the current user.
 *
 * Security behavior:
 * - Excludes self-authored ledger rows (`subjectId <> currentUserId`) to prevent self-notifications.
 *
 * @param limit Max notification ledger rows.
 * @returns Serialized notifications with actor display metadata.
 * @throws {Error} May throw on database query failures.
 * @example
 * ```ts
 * const notifications = await fetchNotifications(100);
 * ```
 */
export async function fetchNotifications(limit = 100): Promise<SerializedNotification[]> {
  const session = await auth();
  const currentUserId = session?.user?.id;
  if (!currentUserId) return [];

  const entries = await db.query.ledger.findMany({
    where: and(
      eq(ledger.objectType, "agent"),
      eq(ledger.objectId, currentUserId),
      sql`${ledger.subjectId} <> ${currentUserId}`
    ),
    orderBy: [desc(ledger.timestamp)],
    limit,
  });

  if (entries.length === 0) return [];

  const actorIds = Array.from(new Set(entries.map((entry) => entry.subjectId)));
  const actorRows =
    actorIds.length > 0
      ? await db
          .select({ id: agents.id, name: agents.name, image: agents.image, metadata: agents.metadata })
          .from(agents)
          .where(inArray(agents.id, actorIds))
      : [];
  const actorById = new Map(actorRows.map((row) => [row.id, row]));

  const verbLabel = (verb: string) => {
    if (verb === "follow") return "started following you";
    if (verb === "comment") return "commented";
    if (verb === "react") return "reacted";
    if (verb === "join") return "joined";
    if (verb === "invite") return "invited you";
    if (verb === "attend") return "RSVP'd";
    return verb;
  };

  return entries.map((entry) => {
    const actor = actorById.get(entry.subjectId);
    const metadata = parseMeta(entry.metadata);
    const explicitMessage = typeof metadata.message === "string" ? metadata.message : null;

    return {
      id: entry.id,
      type: entry.verb,
      actorId: entry.subjectId,
      actorName: actor?.name ?? "Unknown",
      actorUsername:
        actor && actor.metadata && typeof (actor.metadata as Record<string, unknown>).username === "string"
          ? String((actor.metadata as Record<string, unknown>).username)
          : null,
      actorImage: actor?.image ?? null,
      targetId: typeof metadata.targetId === "string" ? metadata.targetId : null,
      message: explicitMessage ?? verbLabel(entry.verb),
      timestamp: entry.timestamp.toISOString(),
    };
  });
}

/**
 * Reads notification read-state flags for the requested notification ids.
 *
 * Business rule:
 * - Uses newest-first scan and first-write-wins in `readState` to capture latest marker per id.
 *
 * @param notificationIds Notification ids to inspect.
 * @returns Map of notification id to boolean read status.
 * @throws {Error} May throw on database query failures.
 * @example
 * ```ts
 * const state = await fetchNotificationReadState(notificationIds);
 * ```
 */
export async function fetchNotificationReadState(
  notificationIds: string[]
): Promise<Record<string, boolean>> {
  const session = await auth();
  const currentUserId = session?.user?.id;
  if (!currentUserId || notificationIds.length === 0) return {};

  const entries = await db.query.ledger.findMany({
    where: and(eq(ledger.verb, "view"), eq(ledger.subjectId, currentUserId)),
    orderBy: [desc(ledger.timestamp)],
    limit: 1000,
  });

  const wanted = new Set(notificationIds);
  const readState: Record<string, boolean> = {};

  for (const entry of entries) {
    const meta = parseMeta(entry.metadata);
    if (meta.kind !== "notification-read") continue;

    const notificationId = typeof meta.notificationId === "string" ? meta.notificationId : "";
    if (!notificationId || !wanted.has(notificationId)) continue;
    if (notificationId in readState) continue;

    readState[notificationId] = Boolean(meta.isRead);
  }

  return readState;
}

/**
 * Sets read/unread state for a single notification by appending a ledger marker.
 *
 * @param params Payload containing notification id and desired read state.
 * @returns Resolves when write completes or no-op conditions are met.
 * @throws {Error} May throw on database insert failures.
 * @example
 * ```ts
 * await setNotificationReadState({ notificationId, isRead: true });
 * ```
 */
export async function setNotificationReadState(params: {
  notificationId: string;
  isRead: boolean;
}): Promise<void> {
  const session = await auth();
  const currentUserId = session?.user?.id;
  if (!currentUserId || !params.notificationId) return;

  await db.insert(ledger).values({
    verb: "view",
    subjectId: currentUserId,
    objectType: "notification",
    metadata: {
      kind: "notification-read",
      notificationId: params.notificationId,
      isRead: params.isRead,
    },
  } as typeof ledger.$inferInsert);

  revalidatePath("/notifications");
}

/**
 * Marks all supplied notifications as read for the current user.
 *
 * @param notificationIds Notification ids to mark read.
 * @returns Resolves when batch write completes or no-op conditions are met.
 * @throws {Error} May throw on database insert failures.
 * @example
 * ```ts
 * await markAllNotificationsAsRead(notificationIds);
 * ```
 */
export async function markAllNotificationsAsRead(notificationIds: string[]): Promise<void> {
  const MAX_NOTIFICATION_IDS = 1000;
  const session = await auth();
  const currentUserId = session?.user?.id;

  if (!currentUserId || notificationIds.length === 0) return;

  // Cap to prevent unbounded array inserts.
  const cappedIds = notificationIds.slice(0, MAX_NOTIFICATION_IDS);

  await db.insert(ledger).values(
    cappedIds.map((notificationId) => ({
      verb: "view" as const,
      subjectId: currentUserId,
      objectType: "notification",
      metadata: {
        kind: "notification-read",
        notificationId,
        isRead: true,
      },
    } as typeof ledger.$inferInsert))
  );

  revalidatePath("/notifications");
}
