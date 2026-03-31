import { and, desc, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  federationAuditLog,
  federationEvents,
  type NewFederationAuditLogRecord,
} from "@/db/schema";

/**
 * Federation audit and dead-letter management utilities.
 *
 * Purpose:
 * - Persist structured audit records for federation operations.
 * - Move failed events into dead-letter state and support retries.
 * - Query audit history with optional filtering and bounded limits.
 *
 * Key exports:
 * - Audit constants and union types for event/status values.
 * - {@link logFederationAudit}
 * - {@link logDeadLetter}
 * - {@link retryDeadLetterEvents}
 * - {@link getAuditLog}
 *
 * Dependencies:
 * - `@/db` and federation tables (`federation_audit_log`, `federation_events`).
 * - Drizzle ORM query helpers for safe predicate composition.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid audit event types for federation operations */
export const FEDERATION_AUDIT_EVENT_TYPES = [
  "import",
  "export",
  "peer_connect",
  "peer_rotate",
  "peer_revoke",
] as const;

/**
 * String union of supported federation audit event types.
 */
export type FederationAuditEventType = (typeof FEDERATION_AUDIT_EVENT_TYPES)[number];

/** Valid audit statuses */
export const FEDERATION_AUDIT_STATUSES = [
  "success",
  "failure",
  "rejected",
] as const;

/**
 * String union of supported federation audit statuses.
 */
export type FederationAuditStatus = (typeof FEDERATION_AUDIT_STATUSES)[number];

/** Default limit for audit log queries when callers do not supply one. */
const DEFAULT_AUDIT_LOG_LIMIT = 50;

/** Upper bound for audit/dead-letter query limits to prevent unbounded scans. */
const MAX_AUDIT_LOG_LIMIT = 500;

/** Default limit for dead-letter retry batches. */
const DEFAULT_RETRY_LIMIT = 25;

// ---------------------------------------------------------------------------
// Audit log entry creation
// ---------------------------------------------------------------------------

export interface LogFederationAuditParams {
  eventType: FederationAuditEventType;
  nodeId?: string | null;
  peerNodeId?: string | null;
  federationEventId?: string | null;
  actorId?: string | null;
  status: FederationAuditStatus;
  detail?: Record<string, unknown>;
}

/**
 * Write a single audit log entry for a federation operation.
 * Returns the created record.
 *
 * @param params Structured audit data for one federation action.
 * @returns Newly inserted audit log row.
 * @throws {Error} May propagate database write errors.
 * @example
 * ```ts
 * await logFederationAudit({
 *   eventType: "export",
 *   status: "success",
 *   nodeId: "node-1",
 *   detail: { entityType: "agent" },
 * });
 * ```
 */
export async function logFederationAudit(
  params: LogFederationAuditParams
): Promise<typeof federationAuditLog.$inferSelect> {
  const values: NewFederationAuditLogRecord = {
    eventType: params.eventType,
    nodeId: params.nodeId ?? null,
    peerNodeId: params.peerNodeId ?? null,
    federationEventId: params.federationEventId ?? null,
    actorId: params.actorId ?? null,
    status: params.status,
    detail: params.detail ?? {},
  };

  const [record] = await db
    .insert(federationAuditLog)
    .values(values)
    .returning();

  return record;
}

// ---------------------------------------------------------------------------
// Dead-letter queue operations
// ---------------------------------------------------------------------------

export interface LogDeadLetterParams {
  federationEventId: string;
  error: string;
  nodeId?: string | null;
  peerNodeId?: string | null;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Mark a federation event as failed (dead-letter) and log an audit entry.
 * Sets the event status to 'failed' and populates the error column.
 * Returns the created audit log record.
 *
 * @param params Dead-letter metadata including the failed event ID and reason.
 * @returns Audit log row created for the dead-letter operation.
 * @throws {Error} May propagate database update/insert errors.
 * @example
 * ```ts
 * await logDeadLetter({
 *   federationEventId: "evt-123",
 *   error: "invalid signature",
 *   nodeId: "node-1",
 * });
 * ```
 */
export async function logDeadLetter(
  params: LogDeadLetterParams
): Promise<typeof federationAuditLog.$inferSelect> {
  const now = new Date();

  // Mark the event as failed before writing audit metadata so queue processors see consistent state.
  await db
    .update(federationEvents)
    .set({
      status: "failed",
      error: params.error,
      updatedAt: now,
    })
    .where(eq(federationEvents.id, params.federationEventId));

  // Persist failure details in audit log for traceability and operational triage.
  return logFederationAudit({
    eventType: "import",
    nodeId: params.nodeId,
    peerNodeId: params.peerNodeId,
    federationEventId: params.federationEventId,
    actorId: params.actorId,
    status: "failure",
    detail: {
      error: params.error,
      ...(params.detail ?? {}),
    },
  });
}

export interface RetryDeadLetterResult {
  retriedCount: number;
  eventIds: string[];
}

/**
 * Find failed (dead-letter) federation events for a given node and reset
 * them to 'queued' status so they can be reprocessed.
 *
 * Returns the count and IDs of events that were reset.
 *
 * @param nodeId Node whose failed origin events should be retried.
 * @param limit Optional batch size override (capped by internal maximum).
 * @returns Retry summary with event IDs moved back to `queued`.
 * @throws {Error} May propagate database query/update errors.
 * @example
 * ```ts
 * const result = await retryDeadLetterEvents("node-1", 20);
 * console.log(result.retriedCount);
 * ```
 */
export async function retryDeadLetterEvents(
  nodeId: string,
  limit?: number
): Promise<RetryDeadLetterResult> {
  const effectiveLimit = Math.min(
    limit ?? DEFAULT_RETRY_LIMIT,
    MAX_AUDIT_LOG_LIMIT
  );

  // Retry is intentionally scoped to origin events for this node to avoid cross-node ownership issues.
  const failedEvents = await db.query.federationEvents.findMany({
    where: and(
      eq(federationEvents.status, "failed"),
      eq(federationEvents.originNodeId, nodeId)
    ),
    columns: { id: true },
    orderBy: [desc(federationEvents.createdAt)],
    limit: effectiveLimit,
  });

  if (failedEvents.length === 0) {
    return { retriedCount: 0, eventIds: [] };
  }

  const eventIds = failedEvents.map((e) => e.id);
  const now = new Date();

  // Clear processing markers so downstream workers treat each event as fresh work.
  await db
    .update(federationEvents)
    .set({
      status: "queued",
      error: null,
      processedAt: null,
      updatedAt: now,
    })
    .where(inArray(federationEvents.id, eventIds));

  return { retriedCount: eventIds.length, eventIds };
}

// ---------------------------------------------------------------------------
// Audit log querying
// ---------------------------------------------------------------------------

export interface GetAuditLogParams {
  eventType?: FederationAuditEventType;
  nodeId?: string;
  status?: FederationAuditStatus;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

/**
 * Query the federation audit log with optional filters.
 * Returns records ordered by creation time descending (most recent first).
 *
 * @param params Optional filter set and limit configuration.
 * @returns Matching audit records ordered newest-first.
 * @throws {Error} May propagate database query errors.
 * @example
 * ```ts
 * const logs = await getAuditLog({ nodeId: "node-1", status: "failure", limit: 100 });
 * ```
 */
export async function getAuditLog(
  params: GetAuditLogParams = {}
): Promise<(typeof federationAuditLog.$inferSelect)[]> {
  const effectiveLimit = Math.min(
    params.limit ?? DEFAULT_AUDIT_LOG_LIMIT,
    MAX_AUDIT_LOG_LIMIT
  );

  // Build predicates incrementally so all filters are optional and composable.
  const conditions = [];

  if (params.eventType) {
    conditions.push(eq(federationAuditLog.eventType, params.eventType));
  }

  if (params.nodeId) {
    conditions.push(eq(federationAuditLog.nodeId, params.nodeId));
  }

  if (params.status) {
    conditions.push(eq(federationAuditLog.status, params.status));
  }

  if (params.startDate) {
    conditions.push(gte(federationAuditLog.createdAt, params.startDate));
  }

  if (params.endDate) {
    conditions.push(lte(federationAuditLog.createdAt, params.endDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  return db.query.federationAuditLog.findMany({
    where: whereClause,
    orderBy: [desc(federationAuditLog.createdAt)],
    limit: effectiveLimit,
  });
}
