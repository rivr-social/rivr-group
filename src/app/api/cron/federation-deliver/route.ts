/**
 * Federation event outbound delivery cron.
 *
 * Purpose:
 * - Push queued local `federation_events` to every trusted peer's
 *   `/api/federation/events/import` endpoint, then mark the events
 *   as `exported` so they are not re-sent on the next tick.
 *
 * Why this route exists:
 * - The pull-side cron (`/api/cron/federation-sync`) only fetches
 *   events FROM peers; nothing previously pushed our queued events
 *   TO peers. The outbound chain was effectively unwired, so events
 *   emitted by `emitDomainEvent` never reached any peer.
 *
 * Auth:
 * - The route is reachable from outside the runtime (it is in the
 *   PUBLIC_API allow-list so a host scheduler can hit it). The
 *   handler itself is gated by a single-tenant bearer secret,
 *   `FEDERATION_DELIVER_CRON_SECRET`. The route fails closed when
 *   the env var is unset to avoid an accidentally-public outbound
 *   delivery worker.
 *
 * Outbound auth (peer side):
 * - The receiver expects either `x-peer-slug` + `x-peer-secret`
 *   (per-peer plaintext shared secret) or `x-node-admin-key`. Plaintext
 *   peer secrets cannot be re-derived from `node_peers.peerSecretHash`
 *   (which is the SHA-256 of the secret), so we look up the plaintext
 *   secret for each peer in the env (`FEDERATION_PEER_SECRET_<UPPER_SLUG>`)
 *   and fall back to `NODE_ADMIN_KEY` if none is configured. Operators
 *   wire the per-peer secret returned by `connectPeer` / `rotatePeerSecret`
 *   into the env once when bootstrapping the peer relationship.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { nodePeers, nodes } from "@/db/schema";
import {
  ensureLocalNode,
  listExportableEvents,
  markEventsExported,
} from "@/lib/federation";
import { signPayload } from "@/lib/federation-crypto";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bearer secret env name. Route fails closed when missing. */
const CRON_SECRET_ENV = "FEDERATION_DELIVER_CRON_SECRET";

/** Per-peer plaintext secret env prefix. Suffix is the peer slug, uppercased + non-alnum → `_`. */
const PEER_SECRET_ENV_PREFIX = "FEDERATION_PEER_SECRET_";

/** Fallback admin auth env name when no per-peer secret is configured. */
const ADMIN_KEY_ENV = "NODE_ADMIN_KEY";

/** Path on the peer that accepts batch import. */
const PEER_IMPORT_PATH = "/api/federation/events/import";

/** Trust state in `nodePeers` that gates outbound delivery. */
const TRUSTED_TRUST_STATE = "trusted" as const;

/** Per-request timeout when POSTing to a peer; keep tight so a sick peer cannot stall the loop. */
const PEER_POST_TIMEOUT_MS = 10_000;

/** Max events delivered to a single peer per tick. Matches the importer rate-limit window. */
const MAX_EVENTS_PER_PEER = 100;

/** Bearer prefix accepted on the `Authorization` header. */
const BEARER_PREFIX = "Bearer ";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PeerDeliveryResult {
  peerSlug: string;
  attempted: number;
  delivered: number;
  error?: string;
}

interface DeliveryResponse {
  ok: boolean;
  processed: number;
  errors: string[];
  results: PeerDeliveryResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the outbound auth header pair for a given peer slug.
 *
 * Returns the per-peer plaintext secret when configured; otherwise
 * the admin-key fallback. Returns null when neither is configured —
 * the caller treats that as an unrecoverable misconfiguration for
 * that peer and skips delivery.
 */
function resolvePeerAuth(peerSlug: string): { mode: "peer" | "admin"; secret: string } | null {
  const upperSlug = peerSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envName = `${PEER_SECRET_ENV_PREFIX}${upperSlug}`;
  const peerSecret = process.env[envName]?.trim();
  if (peerSecret) return { mode: "peer", secret: peerSecret };

  const adminKey = process.env[ADMIN_KEY_ENV]?.trim();
  if (adminKey) return { mode: "admin", secret: adminKey };

  return null;
}

/**
 * Build the import request body in the shape the receiver expects.
 *
 * `importFederationEvents` reads `entityType`, `eventType`, `visibility`,
 * `payload`, `signature`, `nonce`, `eventVersion`, and `createdAt` per event.
 */
function buildImportBody(
  fromPeerSlug: string,
  events: Awaited<ReturnType<typeof listExportableEvents>>,
) {
  return {
    fromPeerSlug,
    events: events.map((e) => ({
      id: e.id,
      entityId: e.entityId,
      actorId: e.actorId,
      entityType: e.entityType,
      eventType: e.eventType,
      visibility: e.visibility,
      payload: e.payload ?? {},
      signature: e.signature ?? undefined,
      nonce: e.nonce ?? undefined,
      eventVersion: e.eventVersion ?? undefined,
      createdAt: e.createdAt?.toISOString(),
    })),
  };
}

async function postBatchToPeer(params: {
  peerBaseUrl: string;
  body: ReturnType<typeof buildImportBody>;
  fromPeerSlug: string;
  auth: NonNullable<ReturnType<typeof resolvePeerAuth>>;
}): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.auth.mode === "peer") {
    headers["x-peer-slug"] = params.fromPeerSlug;
    headers["x-peer-secret"] = params.auth.secret;
  } else {
    headers["x-node-admin-key"] = params.auth.secret;
  }

  try {
    const response = await fetch(`${params.peerBaseUrl.replace(/\/+$/, "")}${PEER_IMPORT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: AbortSignal.timeout(PEER_POST_TIMEOUT_MS),
    });

    if (response.ok) return { ok: true, status: response.status };

    let detail = "";
    try {
      const text = await response.text();
      detail = text.slice(0, 200);
    } catch {
      // ignore body read failures — status alone is enough to log.
    }
    return {
      ok: false,
      status: response.status,
      reason: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : "unknown network error";
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * POST /api/cron/federation-deliver
 *
 * For each trusted peer of the local node:
 *   1. List queued, peer-eligible events (per-peer-targeted OR public).
 *   2. POST the batch to the peer's `/api/federation/events/import`.
 *   3. On 2xx, mark the delivered event ids as `exported` locally.
 *   4. On non-2xx, log and continue to the next peer.
 *
 * Returns `{ ok, processed, errors, results }`. Per-peer outcomes are in
 * `results` so an operator can inspect partial success.
 */
export async function POST(request: NextRequest) {
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
    const localNode = await ensureLocalNode();
    const config = getInstanceConfig();

    // Trusted peers, joined to nodes for slug + base url.
    const trustedPeers = await db
      .select({
        peerLinkId: nodePeers.id,
        peerNodeId: nodes.id,
        peerSlug: nodes.slug,
        peerBaseUrl: nodes.baseUrl,
      })
      .from(nodePeers)
      .innerJoin(nodes, eq(nodes.id, nodePeers.peerNodeId))
      .where(
        and(
          eq(nodePeers.localNodeId, localNode.id),
          eq(nodePeers.trustState, TRUSTED_TRUST_STATE),
        ),
      );

    const results: PeerDeliveryResult[] = [];
    const errors: string[] = [];
    let totalDelivered = 0;

    for (const peer of trustedPeers) {
      if (!peer.peerBaseUrl) {
        const msg = `peer ${peer.peerSlug} has no baseUrl`;
        errors.push(msg);
        results.push({ peerSlug: peer.peerSlug, attempted: 0, delivered: 0, error: msg });
        continue;
      }

      const auth = resolvePeerAuth(peer.peerSlug);
      if (!auth) {
        const msg = `no auth credential configured for peer ${peer.peerSlug} (set ${PEER_SECRET_ENV_PREFIX}${peer.peerSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_")} or ${ADMIN_KEY_ENV})`;
        errors.push(msg);
        results.push({ peerSlug: peer.peerSlug, attempted: 0, delivered: 0, error: msg });
        continue;
      }

      // Per-peer-targeted events first: these were emitted with an
      // explicit `targetNodeId` and are eligible only for that peer.
      const targetedEvents = await listExportableEvents({
        originNodeId: localNode.id,
        targetNodeSlug: peer.peerSlug,
        limit: MAX_EVENTS_PER_PEER,
      });

      // Untargeted public-broadcast events: emitted with `targetNodeId`
      // null and non-private visibility. These should fan out to every
      // trusted peer (each peer's importer applies its own scope+
      // membership filter to decide whether to materialize a resource).
      // Without this branch, normal user-facing creates — which never
      // set a target — would never reach any peer.
      const broadcastEvents = await listExportableEvents({
        originNodeId: localNode.id,
        limit: MAX_EVENTS_PER_PEER,
      });

      // De-dupe by id when an event happens to qualify as both targeted
      // and broadcast (defensive — listExportableEvents excludes private
      // from the broadcast branch already).
      const eventsById = new Map<string, (typeof targetedEvents)[number]>();
      for (const e of targetedEvents) eventsById.set(e.id, e);
      for (const e of broadcastEvents) eventsById.set(e.id, e);
      const events = Array.from(eventsById.values()).slice(0, MAX_EVENTS_PER_PEER);

      if (events.length === 0) {
        results.push({ peerSlug: peer.peerSlug, attempted: 0, delivered: 0 });
        continue;
      }

      // Re-sign every event with the local node's current private key
      // before delivery. Some legacy queued rows were emitted before the
      // keypair was provisioned (signature column nullable); without
      // resigning here those rows would be rejected by peers as "missing
      // signature" forever. Resigning is also defensive against key
      // rotations between emit time and delivery time.
      const eventsForDelivery = await Promise.all(
        events.map(async (e) => {
          if (e.signature) return e;
          if (!localNode.privateKey) return e;
          try {
            const signature = signPayload(
              e.payload as Record<string, unknown>,
              localNode.privateKey,
            );
            return { ...e, signature };
          } catch (err) {
            console.warn(
              `[federation-deliver] failed to re-sign event ${e.id}:`,
              err instanceof Error ? err.message : err,
            );
            return e;
          }
        }),
      );
      const body = buildImportBody(config.instanceSlug, eventsForDelivery);
      const outcome = await postBatchToPeer({
        peerBaseUrl: peer.peerBaseUrl,
        body,
        fromPeerSlug: config.instanceSlug,
        auth,
      });

      if (outcome.ok) {
        await markEventsExported(events.map((e) => e.id));
        totalDelivered += events.length;
        results.push({
          peerSlug: peer.peerSlug,
          attempted: events.length,
          delivered: events.length,
        });
      } else {
        const msg = `peer ${peer.peerSlug}: ${outcome.reason ?? "unknown error"}`;
        errors.push(msg);
        results.push({
          peerSlug: peer.peerSlug,
          attempted: events.length,
          delivered: 0,
          error: outcome.reason,
        });
      }
    }

    const response: DeliveryResponse = {
      ok: true,
      processed: totalDelivered,
      errors,
      results,
    };
    return NextResponse.json(response, { status: STATUS_OK });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    console.error("[federation-deliver] cron failed:", message);
    return NextResponse.json(
      { ok: false, processed: 0, errors: [message], results: [] },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
