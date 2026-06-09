/**
 * Federation event pull-sync cron.
 *
 * Purpose:
 * - Poll every trusted peer's `/api/federation/events` feed for events
 *   we have not yet ingested, then route the batch through the same
 *   `importFederationEvents` path the import API uses.
 * - Run registered local projections against the local event store
 *   after persistence so projection side-effects stay in sync.
 *
 * Why this changed:
 * - The previous handler fetched events from the peer feed but never
 *   inserted them into local `federation_events` — only
 *   `agentCardProjection` ran, against an empty local view. The
 *   handler also accepted unauthenticated GETs.
 *
 * Auth:
 * - Cron-only. Gated by bearer token `FEDERATION_SYNC_CRON_SECRET`.
 *   Fails closed when the env var is unset.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { nodePeers, nodes, type VisibilityLevel } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { EventConsumer } from "@/lib/federation/projections/consumer";
import { agentCardProjection } from "@/lib/federation/projections/agent-cards";
import { ensureLocalNode, importFederationEvents } from "@/lib/federation";
import {
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PEER_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_LIMIT = 100;

/** Bearer secret env name. Route fails closed when missing. */
const CRON_SECRET_ENV = "FEDERATION_SYNC_CRON_SECRET";

/** Trust state in `nodePeers` that gates inbound polling. */
const TRUSTED_TRUST_STATE = "trusted" as const;

const BEARER_PREFIX = "Bearer ";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PeerSyncResult {
  peer: string;
  eventsReceived: number;
  imported: number;
  newCursor: number | null;
  error?: string;
}

interface PeerEventDto {
  id?: string;
  sequence?: number | null;
  entityType: string;
  entityId?: string | null;
  eventType: string;
  actorId?: string | null;
  visibility: VisibilityLevel;
  payload: Record<string, unknown>;
  signature?: string | null;
  nonce?: string | null;
  eventVersion?: number | null;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * GET /api/cron/federation-sync
 *
 * For each trusted peer of the local node:
 *   1. Fetch new events from `${peer.baseUrl}/api/federation/events?since=<cursor>`.
 *   2. Hand the batch to `importFederationEvents` which signs/replay-checks
 *      and persists into local `federation_events` (and runs the
 *      materializer for `agent`/`resource` upserts).
 *   3. Advance the per-peer cursor (`nodes.eventSequence`) on success.
 *   4. Run registered projections against the local event store.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env[CRON_SECRET_ENV]?.trim();
  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: `${CRON_SECRET_ENV} is not configured. Refusing to run.` },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: STATUS_UNAUTHORIZED });
  }
  const presented = authHeader.slice(BEARER_PREFIX.length).trim();
  if (presented !== cronSecret) {
    return NextResponse.json({ ok: false, error: "Invalid cron secret" }, { status: STATUS_UNAUTHORIZED });
  }

  try {
    const config = getInstanceConfig();
    const localNode = await ensureLocalNode();

    const peers = await db
      .select({
        peerNodeId: nodes.id,
        peerSlug: nodes.slug,
        peerBaseUrl: nodes.baseUrl,
        peerEventSequence: nodes.eventSequence,
      })
      .from(nodePeers)
      .innerJoin(nodes, eq(nodes.id, nodePeers.peerNodeId))
      .where(
        and(
          eq(nodePeers.localNodeId, localNode.id),
          eq(nodePeers.trustState, TRUSTED_TRUST_STATE),
        ),
      );

    const consumer = new EventConsumer();
    consumer.register(agentCardProjection);

    const results: PeerSyncResult[] = [];

    for (const peer of peers) {
      if (!peer.peerBaseUrl) {
        results.push({
          peer: peer.peerSlug,
          eventsReceived: 0,
          imported: 0,
          newCursor: null,
          error: "No baseUrl configured",
        });
        continue;
      }

      const cursor = peer.peerEventSequence ?? 0;

      try {
        const response = await fetch(
          `${peer.peerBaseUrl.replace(/\/+$/, "")}/api/federation/events?since=${cursor}&limit=${DEFAULT_EVENT_LIMIT}`,
          {
            headers: {
              "X-Instance-Id": config.instanceId,
              "X-Instance-Slug": config.instanceSlug,
            },
            signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          results.push({
            peer: peer.peerSlug,
            eventsReceived: 0,
            imported: 0,
            newCursor: null,
            error: `HTTP ${response.status} ${response.statusText}`,
          });
          continue;
        }

        const data = (await response.json()) as {
          success?: boolean;
          events?: PeerEventDto[];
          cursor?: number;
          error?: string;
        };

        if (!data.success) {
          results.push({
            peer: peer.peerSlug,
            eventsReceived: 0,
            imported: 0,
            newCursor: null,
            error: data.error ?? "Peer returned success=false",
          });
          continue;
        }

        const fetched = Array.isArray(data.events) ? data.events : [];

        if (fetched.length === 0) {
          results.push({
            peer: peer.peerSlug,
            eventsReceived: 0,
            imported: 0,
            newCursor: cursor,
          });
          continue;
        }

        // Persist via the same path the import API uses so signature +
        // replay + version checks all run identically.
        const importResult = await importFederationEvents({
          localNodeId: localNode.id,
          fromPeerSlug: peer.peerSlug,
          events: fetched.map((e) => ({
            id: e.id,
            entityId: e.entityId ?? null,
            entityType: e.entityType,
            eventType: e.eventType,
            visibility: e.visibility,
            payload: e.payload ?? {},
            signature: e.signature ?? undefined,
            nonce: e.nonce ?? undefined,
            eventVersion: e.eventVersion ?? undefined,
            createdAt: e.createdAt,
          })),
          // Locally initiated cursor pull: accept events older than the
          // replay window so this instance can catch up after extended
          // downtime (signature + nonce dedup still apply).
          allowHistorical: true,
        });

        const newCursor = data.cursor ?? cursor;
        if (newCursor !== cursor) {
          await db
            .update(nodes)
            .set({ eventSequence: newCursor, updatedAt: new Date() })
            .where(eq(nodes.id, peer.peerNodeId));
        }

        await consumer.processSince(cursor);

        results.push({
          peer: peer.peerSlug,
          eventsReceived: fetched.length,
          imported: importResult.imported,
          newCursor,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[federation-sync] Peer ${peer.peerSlug} failed:`, message);
        results.push({
          peer: peer.peerSlug,
          eventsReceived: 0,
          imported: 0,
          newCursor: null,
          error: message,
        });
      }
    }

    return NextResponse.json(
      {
        success: true,
        instanceId: config.instanceId,
        instanceSlug: config.instanceSlug,
        peersChecked: peers.length,
        syncResults: results,
      },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    console.error("[federation-sync] cron failed:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
