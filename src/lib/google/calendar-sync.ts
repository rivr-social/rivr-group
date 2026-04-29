/**
 * Outbound + shared sync orchestration between Rivr event resources and
 * Google Calendar (PR2 — two-way sync).
 *
 * This module is the single entry point for "given a Rivr event resource
 * id and its owning group, push it to Google Calendar." It is called
 * from the event-creation/update server actions as a best-effort hook —
 * any failure here is logged and swallowed so the user-visible resource
 * action still succeeds.
 *
 * Responsibilities:
 * - Look up the active per-group Workspace connection.
 * - Resolve the right calendar id.
 * - Decide insert vs patch based on the `resource_external_sync` row.
 * - Suppress echoes of inbound writes (skip pushing back what we just
 *   imported).
 * - Resolve `412 Precondition Failed` via last-write-wins re-read.
 * - Persist the sidecar row + sync metadata atomically with the result.
 *
 * Out of scope here:
 * - Inbound polling (lives in `src/app/api/cron/google-calendar-sync/route.ts`).
 *   That route imports {@link findActiveCalendarConnectionById} and the
 *   error code constants from this file to stay aligned with the
 *   outbound provenance model.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import {
  groupConnections,
  resourceExternalSync,
  resources,
  type GroupConnectionRecord,
  type NewResourceExternalSyncRecord,
  type ResourceExternalSyncRecord,
} from '@/db/schema';
import { GOOGLE_WORKSPACE_PROVIDER } from './constants';
import {
  GoogleCalendarError,
  GOOGLE_CALENDAR_ERROR_CODES,
  insertEvent,
  patchEvent,
  resolveCalendarId,
} from './calendar';
import {
  resourceToGoogleEvent,
  type RivrEventResourceLike,
} from './calendar-mapper';

// ---------------------------------------------------------------------------
// Stable error / outcome codes
// ---------------------------------------------------------------------------

/** Stable codes describing how a single outbound sync attempt resolved. */
export const CALENDAR_SYNC_OUTCOMES = {
  NO_CONNECTION: 'no_connection',
  DISABLED: 'disabled',
  RESOURCE_MISSING: 'resource_missing',
  ECHO_SKIPPED: 'echo_skipped',
  INSERTED: 'inserted',
  PATCHED: 'patched',
  PATCH_PRECONDITION_RESOLVED: 'patch_precondition_resolved',
  MAPPING_FAILED: 'mapping_failed',
  PROVIDER_ERROR: 'provider_error',
} as const;

export type CalendarSyncOutcomeCode =
  (typeof CALENDAR_SYNC_OUTCOMES)[keyof typeof CALENDAR_SYNC_OUTCOMES];

export interface CalendarSyncOutcome {
  ok: boolean;
  code: CalendarSyncOutcomeCode;
  message?: string;
}

// ---------------------------------------------------------------------------
// Shared lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find the Google Workspace connection for a group when calendar sync is
 * enabled. Returns `null` when no connection exists or the toggle is off.
 */
export async function findActiveCalendarConnection(
  groupId: string,
): Promise<GroupConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  if (!row) return null;
  if (!row.config?.calendarSyncEnabled) return null;
  return row;
}

/** Same as {@link findActiveCalendarConnection} but keyed by connection id. */
export async function findActiveCalendarConnectionById(
  connectionId: string,
): Promise<GroupConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(groupConnections)
    .where(eq(groupConnections.id, connectionId))
    .limit(1);

  if (!row) return null;
  if (row.provider !== GOOGLE_WORKSPACE_PROVIDER) return null;
  if (!row.config?.calendarSyncEnabled) return null;
  return row;
}

interface LoadedEventResource {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
}

async function loadEventResource(
  resourceId: string,
): Promise<LoadedEventResource | null> {
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
      updatedAt: resources.updatedAt,
    })
    .from(resources)
    .where(and(eq(resources.id, resourceId), isNull(resources.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function loadSyncRow(
  resourceId: string,
): Promise<ResourceExternalSyncRecord | null> {
  const [row] = await db
    .select()
    .from(resourceExternalSync)
    .where(
      and(
        eq(resourceExternalSync.resourceId, resourceId),
        eq(resourceExternalSync.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Outbound sync entry point
// ---------------------------------------------------------------------------

/**
 * Push a single Rivr event resource to Google Calendar.
 *
 * Best-effort: never throws. The caller is one of the resource-creation
 * actions, which must continue to succeed even if calendar sync fails.
 *
 * Echo suppression:
 * - When the existing sidecar row was last written by a Google inbound
 *   poll AND the resource has not been modified since that import, this
 *   call is a no-op. We only push outbound when the resource was edited
 *   in Rivr after the last sync.
 *
 * Last-write-wins on 412:
 * - When patch returns 412 Precondition Failed (etag mismatch), we
 *   re-issue the patch without `If-Match`. The newer Rivr edit wins —
 *   the spec calls this last-write-wins by `updated`. If the Google
 *   write is genuinely newer, the next inbound poll will overwrite us.
 */
export async function syncResourceToGoogle(
  resourceId: string,
  groupId: string,
): Promise<CalendarSyncOutcome> {
  const connection = await findActiveCalendarConnection(groupId);
  if (!connection) {
    return { ok: true, code: CALENDAR_SYNC_OUTCOMES.NO_CONNECTION };
  }

  const resource = await loadEventResource(resourceId);
  if (!resource) {
    return { ok: false, code: CALENDAR_SYNC_OUTCOMES.RESOURCE_MISSING };
  }

  const calendarId = resolveCalendarId(connection);
  const syncRow = await loadSyncRow(resourceId);

  // Echo suppression: skip when the most recent sync was an inbound import
  // AND the resource has not been edited in Rivr since that import.
  if (syncRow && syncRow.provenance === 'google_inbound') {
    const resourceUpdatedAt = resource.updatedAt.getTime();
    const lastSyncedAt = syncRow.syncedAt.getTime();
    if (resourceUpdatedAt <= lastSyncedAt) {
      return { ok: true, code: CALENDAR_SYNC_OUTCOMES.ECHO_SKIPPED };
    }
  }

  let body: ReturnType<typeof resourceToGoogleEvent>;
  try {
    body = resourceToGoogleEvent(resource as RivrEventResourceLike);
  } catch (error) {
    return {
      ok: false,
      code: CALENDAR_SYNC_OUTCOMES.MAPPING_FAILED,
      message: error instanceof Error ? error.message : 'Unknown mapping error',
    };
  }

  try {
    if (syncRow) {
      return await patchOutbound({
        groupId,
        calendarId,
        syncRow,
        body,
      });
    }
    return await insertOutbound({
      groupId,
      calendarId,
      resourceId,
      body,
    });
  } catch (error) {
    if (error instanceof GoogleCalendarError) {
      return {
        ok: false,
        code: CALENDAR_SYNC_OUTCOMES.PROVIDER_ERROR,
        message: `${error.code}:${error.status}: ${error.message}`,
      };
    }
    return {
      ok: false,
      code: CALENDAR_SYNC_OUTCOMES.PROVIDER_ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ---------------------------------------------------------------------------
// Outbound: insert path
// ---------------------------------------------------------------------------

interface InsertOutboundArgs {
  groupId: string;
  calendarId: string;
  resourceId: string;
  body: ReturnType<typeof resourceToGoogleEvent>;
}

async function insertOutbound(
  args: InsertOutboundArgs,
): Promise<CalendarSyncOutcome> {
  const created = await insertEvent({
    groupId: args.groupId,
    calendarId: args.calendarId,
    event: args.body,
  });

  await persistSyncRow({
    resourceId: args.resourceId,
    calendarId: args.calendarId,
    googleEventId: created.id,
    etag: created.etag ?? null,
    googleUpdated: created.updated ?? null,
    provenance: 'rivr_outbound',
  });

  return { ok: true, code: CALENDAR_SYNC_OUTCOMES.INSERTED };
}

// ---------------------------------------------------------------------------
// Outbound: patch path (with 412 last-write-wins resolution)
// ---------------------------------------------------------------------------

interface PatchOutboundArgs {
  groupId: string;
  calendarId: string;
  syncRow: ResourceExternalSyncRecord;
  body: ReturnType<typeof resourceToGoogleEvent>;
}

async function patchOutbound(
  args: PatchOutboundArgs,
): Promise<CalendarSyncOutcome> {
  let patched;
  try {
    patched = await patchEvent({
      groupId: args.groupId,
      calendarId: args.syncRow.externalCalendarId,
      eventId: args.syncRow.externalId,
      event: args.body,
      etag: args.syncRow.externalEtag ?? null,
    });
    await persistSyncRow({
      resourceId: args.syncRow.resourceId,
      calendarId: args.syncRow.externalCalendarId,
      googleEventId: patched.id,
      etag: patched.etag ?? null,
      googleUpdated: patched.updated ?? null,
      provenance: 'rivr_outbound',
    });
    return { ok: true, code: CALENDAR_SYNC_OUTCOMES.PATCHED };
  } catch (error) {
    const isPrecondition =
      error instanceof GoogleCalendarError &&
      error.code === GOOGLE_CALENDAR_ERROR_CODES.PRECONDITION;
    if (!isPrecondition) throw error;
  }

  // 412 — fall back to a non-OCC patch to enforce last-write-wins.
  const resolved = await patchEvent({
    groupId: args.groupId,
    calendarId: args.syncRow.externalCalendarId,
    eventId: args.syncRow.externalId,
    event: args.body,
    etag: null,
  });
  await persistSyncRow({
    resourceId: args.syncRow.resourceId,
    calendarId: args.syncRow.externalCalendarId,
    googleEventId: resolved.id,
    etag: resolved.etag ?? null,
    googleUpdated: resolved.updated ?? null,
    provenance: 'rivr_outbound',
  });
  return {
    ok: true,
    code: CALENDAR_SYNC_OUTCOMES.PATCH_PRECONDITION_RESOLVED,
  };
}

// ---------------------------------------------------------------------------
// Sidecar persistence (outbound + inbound shared)
// ---------------------------------------------------------------------------

export interface PersistSyncRowArgs {
  resourceId: string;
  calendarId: string;
  googleEventId: string;
  etag: string | null;
  googleUpdated: string | null;
  provenance: 'rivr_outbound' | 'google_inbound';
}

/**
 * Upsert the `resource_external_sync` row for a successful sync.
 *
 * Shared by the outbound sync path here and the inbound poll route so
 * `provenance` and timestamps stay consistent across both directions.
 */
export async function persistSyncRow(args: PersistSyncRowArgs): Promise<void> {
  const now = new Date();
  const externalUpdated = args.googleUpdated ? new Date(args.googleUpdated) : null;

  const insertValues: NewResourceExternalSyncRecord = {
    resourceId: args.resourceId,
    provider: GOOGLE_WORKSPACE_PROVIDER,
    externalId: args.googleEventId,
    externalCalendarId: args.calendarId,
    externalEtag: args.etag,
    externalUpdated,
    provenance: args.provenance,
    syncedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await db
    .insert(resourceExternalSync)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [resourceExternalSync.resourceId, resourceExternalSync.provider],
      set: {
        externalId: args.googleEventId,
        externalCalendarId: args.calendarId,
        externalEtag: args.etag,
        externalUpdated,
        provenance: args.provenance,
        syncedAt: now,
        updatedAt: now,
      },
    });
}
