/**
 * Inbound Google Calendar polling cron (PR2 slice 3).
 *
 * Iterates every active per-group Google Workspace connection (where
 * `config.calendarSyncEnabled` is true), fetches the calendar's recent
 * changes via the Google Calendar v3 `events.list` endpoint, and applies
 * them to Rivr event resources via the same shared sidecar persistence
 * layer the outbound path uses.
 *
 * Sync model:
 * - Persist Google's incremental `syncToken` per (connection, calendarId)
 *   in `cron_state_google_calendar`. When present, the next poll passes
 *   `syncToken=<…>` to get only what changed.
 * - On the first poll (no token) or after a 410 invalidates a token, fall
 *   back to `updatedMin = lastSyncedAt - 5 minutes`. The 5-minute margin
 *   protects against clock skew and minor reordering.
 * - Walk pages with `nextPageToken`; only the final page returns a
 *   `nextSyncToken`, which we persist for the next run.
 *
 * Echo suppression:
 * - Inbound events whose `(provider, externalCalendarId, externalId,
 *   etag)` already matches a sidecar row written by the outbound path
 *   (provenance='rivr_outbound') are recognized as echoes of our own
 *   write and skipped.
 *
 * Last-write-wins:
 * - For events that already have a sidecar row, compare the inbound
 *   `googleEvent.updated` to the stored `externalUpdated`. Apply the
 *   inbound change only when it is strictly newer; otherwise skip.
 *
 * Auth:
 * - Matches the `BILLING_CRON_SECRET` pattern used by
 *   `/api/billing/trial-reminders`. The configured secret is read from
 *   `CALENDAR_CRON_SECRET` and presented via the `Authorization: Bearer
 *   <secret>` header by the external scheduler. POST is the mutation
 *   verb; GET is rejected so an accidental browser hit cannot run the
 *   job.
 *
 * Scheduling:
 * - This repo has no in-tree scheduler (no `vercel.json`, no
 *   `crons.json`, no node-cron worker). Operators must invoke this
 *   route every ~5 minutes from an external scheduler (host cron,
 *   GitHub Actions, etc.). Slice 4 wires a manual `Sync now` control
 *   in the Connections UI to call the same per-connection logic.
 */

import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import {
  agents,
  cronStateGoogleCalendar,
  groupConnections,
  ledger,
  resourceExternalSync,
  resources,
  type GroupConnectionRecord,
  type NewLedgerEntry,
  type NewResource,
  type ResourceExternalSyncRecord,
} from '@/db/schema';
import { GOOGLE_WORKSPACE_PROVIDER } from '@/lib/google/constants';
import {
  GoogleCalendarError,
  GOOGLE_CALENDAR_ERROR_CODES,
  listEvents,
  resolveCalendarId,
  type GoogleCalendarEvent,
} from '@/lib/google/calendar';
import { googleEventToResourcePatch } from '@/lib/google/calendar-mapper';
import { persistSyncRow } from '@/lib/google/calendar-sync';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_UPDATED_MIN_MARGIN_MS = 5 * 60 * 1000;

/** Stable per-connection outcome codes, surfaced in the JSON response. */
export const INBOUND_SYNC_OUTCOMES = {
  PROCESSED: 'processed',
  TOKEN_INVALIDATED: 'token_invalidated',
  PROVIDER_ERROR: 'provider_error',
} as const;

export type InboundSyncOutcomeCode =
  (typeof INBOUND_SYNC_OUTCOMES)[keyof typeof INBOUND_SYNC_OUTCOMES];

interface ConnectionSyncResult {
  connectionId: string;
  groupId: string;
  calendarId: string;
  outcome: InboundSyncOutcomeCode;
  applied: number;
  skipped: number;
  errors: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorized(request: Request): boolean {
  const configured = process.env.CALENDAR_CRON_SECRET?.trim();
  if (!configured) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${configured}`;
}

// ---------------------------------------------------------------------------
// Public entrypoint — see also `runInboundSyncForConnection` (slice 4 reuses it)
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const connections = await db
    .select()
    .from(groupConnections)
    .where(eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER));

  const results: ConnectionSyncResult[] = [];
  for (const connection of connections) {
    if (!connection.config?.calendarSyncEnabled) continue;
    try {
      const result = await runInboundSyncForConnection(connection);
      results.push(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown sync error';
      console.error(
        `[google-calendar-sync] connection ${connection.id} failed: ${message}`,
      );
      results.push({
        connectionId: connection.id,
        groupId: connection.groupId,
        calendarId: resolveCalendarId(connection),
        outcome: INBOUND_SYNC_OUTCOMES.PROVIDER_ERROR,
        applied: 0,
        skipped: 0,
        errors: 1,
        message,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    results,
  });
}

export function GET(): Response {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

// ---------------------------------------------------------------------------
// Per-connection sync (exported so a manual "Sync now" UI can reuse it)
// ---------------------------------------------------------------------------

/**
 * Run a complete inbound sync pass for a single Google Workspace
 * connection. Drains every page, persists `nextSyncToken` on the final
 * page, and returns a summary the cron and the manual "Sync now"
 * endpoint can both render.
 */
export async function runInboundSyncForConnection(
  connection: GroupConnectionRecord,
): Promise<ConnectionSyncResult> {
  const calendarId = resolveCalendarId(connection);
  const cursor = await loadOrCreateCursor(connection.id, calendarId);

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let tokenInvalidated = false;

  // First request uses syncToken (preferred). On 410 Gone the token is
  // invalidated; clear it and retry with updatedMin in the same call.
  let usedSyncToken = cursor.syncToken;

  do {
    let response;
    try {
      response = await listEvents({
        groupId: connection.groupId,
        calendarId,
        syncToken: usedSyncToken ?? undefined,
        updatedMin: usedSyncToken
          ? undefined
          : computeUpdatedMin(cursor.lastSyncedAt),
        pageToken,
      });
    } catch (error) {
      const isTokenGone =
        error instanceof GoogleCalendarError &&
        error.code === GOOGLE_CALENDAR_ERROR_CODES.NOT_FOUND &&
        usedSyncToken;
      if (isTokenGone) {
        // Reset and retry once with updatedMin.
        tokenInvalidated = true;
        usedSyncToken = null;
        pageToken = undefined;
        continue;
      }
      throw error;
    }

    for (const event of response.events) {
      try {
        const result = await applyInboundEvent({
          connection,
          calendarId,
          event,
        });
        if (result === 'applied') applied += 1;
        else skipped += 1;
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[google-calendar-sync] applyInboundEvent failed (connection=${connection.id}, event=${event.id}): ${message}`,
        );
      }
    }

    pageToken = response.nextPageToken;
    if (response.nextSyncToken) nextSyncToken = response.nextSyncToken;
  } while (pageToken);

  await persistCursor({
    connectionId: connection.id,
    calendarId,
    syncToken: nextSyncToken ?? null,
  });

  return {
    connectionId: connection.id,
    groupId: connection.groupId,
    calendarId,
    outcome: tokenInvalidated
      ? INBOUND_SYNC_OUTCOMES.TOKEN_INVALIDATED
      : INBOUND_SYNC_OUTCOMES.PROCESSED,
    applied,
    skipped,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorRow {
  syncToken: string | null;
  lastSyncedAt: Date | null;
}

async function loadOrCreateCursor(
  connectionId: string,
  calendarId: string,
): Promise<CursorRow> {
  const [existing] = await db
    .select({
      syncToken: cronStateGoogleCalendar.syncToken,
      lastSyncedAt: cronStateGoogleCalendar.lastSyncedAt,
    })
    .from(cronStateGoogleCalendar)
    .where(
      and(
        eq(cronStateGoogleCalendar.connectionId, connectionId),
        eq(cronStateGoogleCalendar.calendarId, calendarId),
      ),
    )
    .limit(1);
  return existing ?? { syncToken: null, lastSyncedAt: null };
}

interface PersistCursorArgs {
  connectionId: string;
  calendarId: string;
  syncToken: string | null;
}

async function persistCursor(args: PersistCursorArgs): Promise<void> {
  const now = new Date();
  await db
    .insert(cronStateGoogleCalendar)
    .values({
      connectionId: args.connectionId,
      calendarId: args.calendarId,
      syncToken: args.syncToken,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        cronStateGoogleCalendar.connectionId,
        cronStateGoogleCalendar.calendarId,
      ],
      set: {
        syncToken: args.syncToken,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });
}

function computeUpdatedMin(lastSyncedAt: Date | null): string | undefined {
  if (!lastSyncedAt) return undefined;
  return new Date(
    lastSyncedAt.getTime() - FALLBACK_UPDATED_MIN_MARGIN_MS,
  ).toISOString();
}

// ---------------------------------------------------------------------------
// Per-event inbound application
// ---------------------------------------------------------------------------

interface ApplyInboundEventArgs {
  connection: GroupConnectionRecord;
  calendarId: string;
  event: GoogleCalendarEvent;
}

type ApplyOutcome = 'applied' | 'skipped';

/**
 * Apply a single inbound Google event to Rivr.
 *
 * - When a sidecar row already exists, dedupe echoes (matching etag from
 *   our own outbound write) and run last-write-wins by `updated`.
 * - When no sidecar row exists, this is a brand-new import — create the
 *   Rivr event resource owned by the group and stamp a
 *   `provenance='google_inbound'` sidecar row.
 */
async function applyInboundEvent(
  args: ApplyInboundEventArgs,
): Promise<ApplyOutcome> {
  const { connection, calendarId, event } = args;

  const [existingSync] = await db
    .select()
    .from(resourceExternalSync)
    .where(
      and(
        eq(resourceExternalSync.provider, GOOGLE_WORKSPACE_PROVIDER),
        eq(resourceExternalSync.externalCalendarId, calendarId),
        eq(resourceExternalSync.externalId, event.id),
      ),
    )
    .limit(1);

  if (existingSync) {
    return applyExistingMapping({
      connection,
      calendarId,
      event,
      existing: existingSync,
    });
  }

  // Skip cancelled events that we have never seen before — there's nothing
  // local to delete.
  if (event.status === 'cancelled') return 'skipped';

  return createInboundResource({ connection, calendarId, event });
}

interface ApplyExistingArgs {
  connection: GroupConnectionRecord;
  calendarId: string;
  event: GoogleCalendarEvent;
  existing: ResourceExternalSyncRecord;
}

async function applyExistingMapping(
  args: ApplyExistingArgs,
): Promise<ApplyOutcome> {
  const { connection, calendarId, event, existing } = args;

  // Echo suppression: same etag we just wrote on an outbound push.
  if (
    existing.provenance === 'rivr_outbound' &&
    existing.externalEtag &&
    event.etag &&
    existing.externalEtag === event.etag
  ) {
    return 'skipped';
  }

  // Last-write-wins by Google's `updated` timestamp.
  const incomingUpdated = event.updated ? new Date(event.updated) : null;
  const recordedUpdated = existing.externalUpdated;
  if (incomingUpdated && recordedUpdated && incomingUpdated <= recordedUpdated) {
    return 'skipped';
  }

  // Cancelled inbound — soft-delete the linked resource.
  if (event.status === 'cancelled') {
    await db
      .update(resources)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(resources.id, existing.resourceId));
    await persistSyncRow({
      resourceId: existing.resourceId,
      calendarId,
      googleEventId: event.id,
      etag: event.etag ?? null,
      googleUpdated: event.updated ?? null,
      provenance: 'google_inbound',
    });
    return 'applied';
  }

  const patch = googleEventToResourcePatch(event);
  if (!patch) return 'skipped';

  // Merge the incoming patch metadata onto the existing metadata to keep
  // any Rivr-side fields the importer doesn't know about.
  const [resourceRow] = await db
    .select({
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, existing.resourceId), isNull(resources.deletedAt)))
    .limit(1);

  if (!resourceRow) {
    // Resource was deleted in Rivr; record the inbound state but don't
    // resurrect a soft-deleted row.
    await persistSyncRow({
      resourceId: existing.resourceId,
      calendarId,
      googleEventId: event.id,
      etag: event.etag ?? null,
      googleUpdated: event.updated ?? null,
      provenance: 'google_inbound',
    });
    return 'skipped';
  }

  const mergedMetadata = {
    ...(resourceRow.metadata ?? {}),
    ...patch.metadata,
  };

  await db.transaction(async (tx) => {
    await tx
      .update(resources)
      .set({
        name: patch.name,
        description: patch.description,
        metadata: mergedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(resources.id, existing.resourceId));

    await tx.insert(ledger).values({
      verb: 'update',
      subjectId: connection.connectedByUserId,
      objectId: existing.resourceId,
      objectType: 'resource',
      resourceId: existing.resourceId,
      metadata: {
        source: 'google-calendar-sync',
        direction: 'inbound',
        externalCalendarId: calendarId,
        externalEventId: event.id,
      },
    } as NewLedgerEntry);
  });

  await persistSyncRow({
    resourceId: existing.resourceId,
    calendarId,
    googleEventId: event.id,
    etag: event.etag ?? null,
    googleUpdated: event.updated ?? null,
    provenance: 'google_inbound',
  });

  return 'applied';
}

interface CreateInboundResourceArgs {
  connection: GroupConnectionRecord;
  calendarId: string;
  event: GoogleCalendarEvent;
}

async function createInboundResource(
  args: CreateInboundResourceArgs,
): Promise<ApplyOutcome> {
  const { connection, calendarId, event } = args;
  const patch = googleEventToResourcePatch(event);
  if (!patch) return 'skipped';

  // Defensive: confirm the owning group/agent still exists before
  // inserting a resource pointing at it.
  const [group] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, connection.groupId), isNull(agents.deletedAt)))
    .limit(1);
  if (!group) return 'skipped';

  const [created] = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(resources)
      .values({
        name: patch.name,
        type: 'event',
        description: patch.description,
        content: patch.description,
        ownerId: connection.groupId,
        visibility: 'public',
        tags: [],
        metadata: {
          ...patch.metadata,
          groupId: connection.groupId,
        },
      } as NewResource)
      .returning({ id: resources.id });

    await tx.insert(ledger).values({
      verb: 'create',
      subjectId: connection.connectedByUserId,
      objectId: insertedRows[0].id,
      objectType: 'resource',
      resourceId: insertedRows[0].id,
      metadata: {
        source: 'google-calendar-sync',
        direction: 'inbound',
        externalCalendarId: calendarId,
        externalEventId: event.id,
      },
    } as NewLedgerEntry);

    return insertedRows;
  });

  await persistSyncRow({
    resourceId: created.id,
    calendarId,
    googleEventId: event.id,
    etag: event.etag ?? null,
    googleUpdated: event.updated ?? null,
    provenance: 'google_inbound',
  });

  return 'applied';
}
