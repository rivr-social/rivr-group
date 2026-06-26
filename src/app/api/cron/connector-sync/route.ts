/**
 * Scheduled connector import cron (platform-evolution Wave 5).
 *
 * The `/api/connectors` route stores credentials and runs an on-demand
 * `action:"sync"` import, but nothing pulls connector items in the background.
 * This cron closes that gap for the parachute-mirror lane: it iterates every
 * `user_connectors` row whose provider supports a background import
 * ({@link SYNCABLE_CONNECTOR_PROVIDERS}) and runs {@link runConnectorSync} for
 * each, mirroring provider items into `document` Resources via the shared
 * upsert (idempotent — last-write-wins / echo-suppression skips unchanged
 * items, so re-runs don't duplicate).
 *
 * Scope: import-only (Notion today). The on-demand single-item save lane
 * (Gmail) is user-initiated by design and is intentionally NOT driven here.
 *
 * Auth:
 * - Mirrors the `GOOGLE_CALENDAR_SYNC_CRON_SECRET` pattern used by
 *   `/api/cron/google-calendar-sync`. The secret is read from
 *   `CONNECTOR_SYNC_CRON_SECRET` and presented via the
 *   `Authorization: Bearer <secret>` header by the external scheduler. POST is
 *   the mutation verb; GET is rejected so an accidental browser hit cannot run
 *   the job. When the secret is unset the route refuses to run.
 *
 * Scheduling:
 * - This repo has no in-tree scheduler. Operators invoke this route on a cadence
 *   (host cron, GitHub Actions, etc.), same as the calendar-sync cron.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db';
import { userConnectors } from '@/db/schema';
import {
  runConnectorSync,
  SYNCABLE_CONNECTOR_PROVIDERS,
  type NotionSyncResult,
} from '@/lib/connectors/notion-sync';

export const dynamic = 'force-dynamic';

/** Stable per-connector outcome codes, surfaced in the JSON response. */
const CONNECTOR_SYNC_OUTCOMES = {
  PROCESSED: 'processed',
  PROVIDER_ERROR: 'provider_error',
} as const;

type ConnectorSyncOutcomeCode =
  (typeof CONNECTOR_SYNC_OUTCOMES)[keyof typeof CONNECTOR_SYNC_OUTCOMES];

interface ConnectorSyncResult {
  userAgentId: string;
  provider: string;
  outcome: ConnectorSyncOutcomeCode;
  result?: NotionSyncResult;
  message?: string;
}

function isAuthorized(request: Request): boolean {
  const configured = process.env.CONNECTOR_SYNC_CRON_SECRET?.trim();
  if (!configured) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${configured}`;
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const connectors = await db
    .select({
      userAgentId: userConnectors.userAgentId,
      provider: userConnectors.provider,
    })
    .from(userConnectors)
    .where(
      inArray(
        userConnectors.provider,
        SYNCABLE_CONNECTOR_PROVIDERS as readonly string[] as string[],
      ),
    );

  const results: ConnectorSyncResult[] = [];
  for (const connector of connectors) {
    try {
      const result = await runConnectorSync(connector.userAgentId, connector.provider);
      await db
        .update(userConnectors)
        .set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() })
        .where(
          and(
            eq(userConnectors.userAgentId, connector.userAgentId),
            eq(userConnectors.provider, connector.provider),
          ),
        );
      results.push({
        userAgentId: connector.userAgentId,
        provider: connector.provider,
        outcome: CONNECTOR_SYNC_OUTCOMES.PROCESSED,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      console.error(
        `[connector-sync] ${connector.provider} for agent ${connector.userAgentId} failed: ${message}`,
      );
      await db
        .update(userConnectors)
        .set({ lastSyncError: message, updatedAt: new Date() })
        .where(
          and(
            eq(userConnectors.userAgentId, connector.userAgentId),
            eq(userConnectors.provider, connector.provider),
          ),
        );
      results.push({
        userAgentId: connector.userAgentId,
        provider: connector.provider,
        outcome: CONNECTOR_SYNC_OUTCOMES.PROVIDER_ERROR,
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
