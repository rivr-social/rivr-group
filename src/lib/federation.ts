import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import crypto from "crypto";
import {
  agents,
  federationEntityMap,
  federationEvents,
  nodePeers,
  nodes,
  resources,
  type NewFederationEventRecord,
  type NewNodePeerRecord,
  type NewNodeRecord,
  type NodeRole,
  type VisibilityLevel,
} from "@/db/schema";
import {
  generateNodeKeyPair,
  signPayload,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";
import { generatePeerSecret } from "@/lib/federation-auth";
import { logFederationAudit } from "@/lib/federation-audit";

/**
 * Core federation orchestration for node lifecycle, peer trust, event export/import,
 * and peer credential rotation.
 *
 * Purpose:
 * - Bootstrap and maintain the local federation node record.
 * - Connect peers and manage per-peer shared secrets.
 * - Queue signed export events from local entities and import verified remote events.
 * - Provide status and listing utilities for operational workflows.
 *
 * Key exports:
 * - {@link ensureLocalNode}
 * - {@link connectPeer}
 * - {@link getFederationStatus}
 * - {@link queueExportEvents}
 * - {@link markEventsExported}
 * - {@link importFederationEvents}
 * - {@link listExportableEvents}
 * - {@link rotatePeerSecret}
 * - {@link revokePeerCredentials}
 *
 * Dependencies:
 * - Drizzle ORM + federation tables for persistence.
 * - `federation-crypto` for Ed25519 signatures.
 * - `federation-auth` for peer secret generation.
 * - `federation-audit` for operational audit records.
 *
 * Configuration pattern:
 * - Node identity and defaults are environment-driven (`NODE_SLUG`, `NODE_DISPLAY_NAME`,
 *   `NODE_ROLE`, `NEXT_PUBLIC_APP_URL`) with explicit fallbacks.
 */

/** Default node role used when `NODE_ROLE` is unset or invalid. */
const DEFAULT_NODE_ROLE: NodeRole = "global";

/** Visibility levels that are allowed to leave the local node during export/import. */
const EXPORTABLE_VISIBILITIES = new Set<VisibilityLevel>(["public", "locale", "members"]);

/** Maximum age (in milliseconds) for accepted federation events. Events older than this are rejected. */
const EVENT_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getNodeSlug(): string {
  // Slug is a stable node identifier used in routing and peer lookup.
  return process.env.NODE_SLUG?.trim() || "global-host";
}

function getNodeDisplayName(): string {
  // Human-readable display value shown in federation admin views.
  return process.env.NODE_DISPLAY_NAME?.trim() || "Global Host";
}

function getNodeRole(): NodeRole {
  const role = process.env.NODE_ROLE?.trim() as NodeRole | undefined;
  // Guard against unsupported runtime values even if environment is misconfigured.
  if (role && ["group", "locale", "basin", "global"].includes(role)) {
    return role;
  }
  return DEFAULT_NODE_ROLE;
}

function getBaseUrl(): string {
  // Base URL is used by peers to call this node's federation endpoints.
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000";
}

/**
 * Ensure a local hosted federation node exists and has a signing key pair.
 *
 * @param ownerAgentId Optional local agent ID that owns this hosted node.
 * @returns Existing or newly created node record for the local instance.
 * @throws {Error} May propagate database and key-generation failures.
 * @example
 * ```ts
 * const localNode = await ensureLocalNode(session.user.id);
 * ```
 */
export async function ensureLocalNode(ownerAgentId?: string) {
  const slug = getNodeSlug();

  const existing = await db.query.nodes.findFirst({
    where: eq(nodes.slug, slug),
  });

  if (existing) {
    // Backfill keys for legacy nodes so all exported events can be signed.
    if (!existing.privateKey || !existing.publicKey) {
      const keyPair = generateNodeKeyPair();
      const [updated] = await db
        .update(nodes)
        .set({
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const keyPair = generateNodeKeyPair();

  const values: NewNodeRecord = {
    slug,
    displayName: getNodeDisplayName(),
    role: getNodeRole(),
    baseUrl: getBaseUrl(),
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    isHosted: true,
    ownerAgentId: ownerAgentId ?? null,
    metadata: { bootstrappedAt: new Date().toISOString() },
  };

  const [created] = await db.insert(nodes).values(values).returning();
  return created;
}

/**
 * Returns the hosted local node owned by a specific local agent, if one exists.
 * This is the safe preflight for user-initiated federation actions; unlike
 * `ensureLocalNode`, it will not create or reassign a node implicitly.
 */
export async function getHostedNodeForOwner(ownerAgentId: string) {
  return db.query.nodes.findFirst({
    where: and(eq(nodes.ownerAgentId, ownerAgentId), eq(nodes.isHosted, true)),
  });
}

/**
 * Connect or update a peer node and establish trusted shared-secret credentials.
 *
 * @param params Peer identity and endpoint settings for the relationship.
 * @returns Connected peer node/link records plus one-time plaintext peer secret.
 * @throws {Error} May propagate database write errors or audit logging failures.
 * @example
 * ```ts
 * const result = await connectPeer({
 *   localNodeId: "local-node-id",
 *   peerSlug: "peer-a",
 *   peerDisplayName: "Peer A",
 *   peerRole: "global",
 *   peerBaseUrl: "https://peer.example.com",
 *   peerPublicKey: "...pem...",
 * });
 * ```
 */
export async function connectPeer(params: {
  localNodeId: string;
  peerSlug: string;
  peerDisplayName: string;
  peerRole: NodeRole;
  peerBaseUrl: string;
  peerPublicKey: string;
}) {
  const { secret, hash } = generatePeerSecret();

  const [peerNode] = await db
    .insert(nodes)
    .values({
      slug: params.peerSlug,
      displayName: params.peerDisplayName,
      role: params.peerRole,
      baseUrl: params.peerBaseUrl,
      publicKey: params.peerPublicKey,
      isHosted: false,
      metadata: { discoveredVia: "confederation_api" },
    } as NewNodeRecord)
    .onConflictDoUpdate({
      target: nodes.slug,
      set: {
        displayName: params.peerDisplayName,
        role: params.peerRole,
        baseUrl: params.peerBaseUrl,
        publicKey: params.peerPublicKey,
        updatedAt: new Date(),
      },
    })
    .returning();

  const now = new Date();

  const [peer] = await db
    .insert(nodePeers)
    .values({
      localNodeId: params.localNodeId,
      peerNodeId: peerNode.id,
      trustState: "trusted",
      peerSecretHash: hash,
      secretVersion: 1,
      secretRotatedAt: now,
      metadata: { connectedAt: now.toISOString() },
    } as NewNodePeerRecord)
    .onConflictDoUpdate({
      target: [nodePeers.localNodeId, nodePeers.peerNodeId],
      set: {
        trustState: "trusted",
        peerSecretHash: hash,
        secretVersion: 1,
        secretRotatedAt: now,
        updatedAt: now,
      },
    })
    .returning();

  await logFederationAudit({
    eventType: "peer_connect",
    nodeId: params.localNodeId,
    peerNodeId: peerNode.id,
    status: "success",
    detail: {
      peerSlug: params.peerSlug,
      peerBaseUrl: params.peerBaseUrl,
      peerRole: params.peerRole,
    },
  });

  return { peerNode, peer, peerSecret: secret };
}

/**
 * Return high-level federation counters for one local node.
 *
 * @param localNodeId Node ID to inspect.
 * @returns Aggregate counts for trusted peers and federation event states.
 * @throws {Error} May propagate database query errors.
 * @example
 * ```ts
 * const status = await getFederationStatus(localNodeId);
 * ```
 */
export async function getFederationStatus(localNodeId: string) {
  const peers = await db.query.nodePeers.findMany({
    where: and(eq(nodePeers.localNodeId, localNodeId), eq(nodePeers.trustState, "trusted")),
  });

  const queued = await db.query.federationEvents.findMany({
    where: and(eq(federationEvents.originNodeId, localNodeId), eq(federationEvents.status, "queued")),
  });

  const exported = await db.query.federationEvents.findMany({
    where: and(eq(federationEvents.originNodeId, localNodeId), eq(federationEvents.status, "exported")),
  });

  const imported = await db.query.federationEvents.findMany({
    where: and(eq(federationEvents.targetNodeId, localNodeId), eq(federationEvents.status, "imported")),
  });

  return {
    trustedPeers: peers.length,
    queuedEvents: queued.length,
    exportedEvents: exported.length,
    importedEvents: imported.length,
  };
}

/**
 * Create queued export events from local agents/resources that satisfy visibility
 * and optional scope filters.
 *
 * @param params Export selection criteria and destination targeting.
 * @returns Number of queued events and inserted event rows.
 * @throws {Error} Throws when the origin node has no private key or on database failures.
 * @example
 * ```ts
 * const queued = await queueExportEvents({
 *   originNodeId: "node-1",
 *   visibilities: ["public", "members"],
 *   limit: 100,
 * });
 * ```
 */
export async function queueExportEvents(params: {
  originNodeId: string;
  targetNodeId?: string;
  visibilities?: VisibilityLevel[];
  scopeIds?: string[];
  limit?: number;
}) {
  const limit = params.limit ?? 100;
  const requestedVisibilities: VisibilityLevel[] = (params.visibilities?.length
    ? params.visibilities
    : ["public", "locale", "members"]
  );
  const allowedVisibilities = requestedVisibilities.filter(
    (v): v is VisibilityLevel => EXPORTABLE_VISIBILITIES.has(v)
  );
  const requestedScopeIds = Array.isArray(params.scopeIds)
    ? params.scopeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (allowedVisibilities.length === 0) {
    return { queued: 0, events: [] as typeof federationEvents.$inferSelect[] };
  }

  const candidateAgents = await db.query.agents.findMany({
    where: and(
      isNull(agents.deletedAt),
      inArray(agents.visibility, allowedVisibilities)
    ),
    orderBy: [desc(agents.updatedAt)],
    limit,
  });

  const candidateResources = await db.query.resources.findMany({
    where: and(
      isNull(resources.deletedAt),
      inArray(resources.visibility, allowedVisibilities)
    ),
    orderBy: [desc(resources.updatedAt)],
    limit,
  });

  const matchesScope = (candidateScopes: string[] | null | undefined): boolean => {
    if (requestedScopeIds.length === 0) return true;
    // Set-based matching avoids O(n*m) repeated scans for scope intersections.
    const set = new Set((candidateScopes ?? []).filter(Boolean));
    for (const scopeId of requestedScopeIds) {
      if (set.has(scopeId)) return true;
    }
    return false;
  };

  const scopedAgents = candidateAgents.filter((agent) => {
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const chapterTags = Array.isArray(meta.chapterTags)
      ? (meta.chapterTags as string[])
      : [];
    const pathIds = Array.isArray(agent.pathIds) ? agent.pathIds : [];
    const candidateScopes = [...chapterTags, ...pathIds, agent.parentId ?? ""];
    return matchesScope(candidateScopes);
  });

  const scopedResources = candidateResources.filter((resource) => {
    const meta = (resource.metadata ?? {}) as Record<string, unknown>;
    const chapterTags = Array.isArray(meta.chapterTags)
      ? (meta.chapterTags as string[])
      : [];
    const tags = Array.isArray(resource.tags) ? resource.tags : [];
    const candidateScopes = [...chapterTags, ...tags];
    return matchesScope(candidateScopes);
  });

  return queuePreparedExportEvents({
    originNodeId: params.originNodeId,
    targetNodeId: params.targetNodeId,
    candidateAgents: scopedAgents,
    candidateResources: scopedResources,
  });
}

async function queuePreparedExportEvents(params: {
  originNodeId: string;
  targetNodeId?: string;
  candidateAgents: typeof agents.$inferSelect[];
  candidateResources: typeof resources.$inferSelect[];
}) {
  // Exported payloads must be signed to allow remote authenticity verification.
  const originNode = await db.query.nodes.findFirst({
    where: eq(nodes.id, params.originNodeId),
  });
  if (!originNode?.privateKey) {
    throw new Error("Origin node is missing a private key; cannot sign federation events");
  }
  const nodePrivateKey = originNode.privateKey;

  const allEntityIds = [
    ...params.candidateAgents.map((agent) => agent.id),
    ...params.candidateResources.map((resource) => resource.id),
  ];

  const latestVersions = new Map<string, number>();
  if (allEntityIds.length > 0) {
    const existingEvents = await db.query.federationEvents.findMany({
      where: and(
        eq(federationEvents.originNodeId, params.originNodeId),
        inArray(federationEvents.entityId, allEntityIds),
      ),
      columns: { entityId: true, eventVersion: true },
    });
    for (const ev of existingEvents) {
      if (ev.entityId && ev.eventVersion != null) {
        const current = latestVersions.get(ev.entityId) ?? 0;
        if (ev.eventVersion > current) {
          latestVersions.set(ev.entityId, ev.eventVersion);
        }
      }
    }
  }

  const rows: NewFederationEventRecord[] = [
    ...params.candidateAgents.map((agent): NewFederationEventRecord => {
      const visibility = agent.visibility ?? "private";
      const nextVersion = (latestVersions.get(agent.id) ?? 0) + 1;
      const payload: Record<string, unknown> = {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        description: agent.description,
        image: agent.image,
        metadata: agent.metadata,
        visibility,
        parentId: agent.parentId,
        pathIds: agent.pathIds,
      };
      return {
        originNodeId: params.originNodeId,
        targetNodeId: params.targetNodeId ?? null,
        entityType: "agent",
        entityId: agent.id,
        eventType: "upsert",
        visibility,
        payload,
        signature: signPayload(payload, nodePrivateKey),
        nonce: crypto.randomUUID(),
        eventVersion: nextVersion,
        status: "queued",
      };
    }),
    ...params.candidateResources.map((resource): NewFederationEventRecord => {
      const visibility = resource.visibility ?? "private";
      const nextVersion = (latestVersions.get(resource.id) ?? 0) + 1;
      const payload: Record<string, unknown> = {
        id: resource.id,
        name: resource.name,
        type: resource.type,
        description: resource.description,
        ownerId: resource.ownerId,
        visibility,
        metadata: resource.metadata,
        tags: resource.tags,
      };
      return {
        originNodeId: params.originNodeId,
        targetNodeId: params.targetNodeId ?? null,
        entityType: "resource",
        entityId: resource.id,
        eventType: "upsert",
        visibility,
        payload,
        signature: signPayload(payload, nodePrivateKey),
        nonce: crypto.randomUUID(),
        eventVersion: nextVersion,
        status: "queued",
      };
    }),
  ];

  if (rows.length === 0) {
    return { queued: 0, events: [] as typeof federationEvents.$inferSelect[] };
  }

  const inserted = await db.insert(federationEvents).values(rows).returning();

  for (const event of inserted) {
    await logFederationAudit({
      eventType: "export",
      nodeId: params.originNodeId,
      peerNodeId: params.targetNodeId,
      federationEventId: event.id,
      status: "success",
      detail: {
        entityType: event.entityType,
        entityId: event.entityId,
        eventVersion: event.eventVersion,
        visibility: event.visibility,
      },
    });
  }

  return { queued: inserted.length, events: inserted };
}

/**
 * Queue export events for specific local entities. This is the write-path helper
 * for user actions like "federate this post" where we must queue the exact
 * newly-created agent/resource rather than scanning recent public content.
 */
export async function queueEntityExportEvents(params: {
  originNodeId: string;
  targetNodeId?: string;
  agentIds?: string[];
  resourceIds?: string[];
}) {
  const agentIds = Array.isArray(params.agentIds)
    ? params.agentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const resourceIds = Array.isArray(params.resourceIds)
    ? params.resourceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (agentIds.length === 0 && resourceIds.length === 0) {
    return { queued: 0, events: [] as typeof federationEvents.$inferSelect[] };
  }

  const candidateAgents = agentIds.length
    ? await db.query.agents.findMany({
        where: and(
          isNull(agents.deletedAt),
          inArray(agents.id, agentIds),
          inArray(agents.visibility, ["public", "locale", "members"]),
        ),
      })
    : [];

  const candidateResources = resourceIds.length
    ? await db.query.resources.findMany({
        where: and(
          isNull(resources.deletedAt),
          inArray(resources.id, resourceIds),
          inArray(resources.visibility, ["public", "locale", "members"]),
        ),
      })
    : [];

  return queuePreparedExportEvents({
    originNodeId: params.originNodeId,
    targetNodeId: params.targetNodeId,
    candidateAgents,
    candidateResources,
  });
}

/**
 * Mark previously queued federation events as exported.
 *
 * @param eventIds Federation event IDs that were successfully delivered to peers.
 * @returns Resolves when status updates are persisted.
 * @throws {Error} May propagate database update errors.
 * @example
 * ```ts
 * await markEventsExported(["evt-1", "evt-2"]);
 * ```
 */
export async function markEventsExported(eventIds: string[]) {
  // No-op guard prevents generating invalid SQL (`IN ()`) for empty batches.
  if (eventIds.length === 0) return;

  await db
    .update(federationEvents)
    .set({ status: "exported", processedAt: new Date(), updatedAt: new Date() })
    .where(inArray(federationEvents.id, eventIds));
}

/**
 * Resolves a remote entity ID to a local UUID via the federation_entity_map table.
 * If no mapping exists yet, generates a new UUID and creates the mapping.
 */
async function resolveLocalEntityId(
  originNodeId: string,
  externalEntityId: string,
  entityType: "agent" | "resource",
): Promise<string> {
  const existing = await db.query.federationEntityMap.findFirst({
    where: and(
      eq(federationEntityMap.originNodeId, originNodeId),
      eq(federationEntityMap.externalEntityId, externalEntityId),
      eq(federationEntityMap.entityType, entityType),
    ),
  });

  if (existing) {
    return existing.localEntityId;
  }

  const localEntityId = crypto.randomUUID();
  await db.insert(federationEntityMap).values({
    originNodeId,
    externalEntityId,
    localEntityId,
    entityType,
  });

  return localEntityId;
}

/**
 * Import inbound federation events from a trusted peer, enforcing signature,
 * replay, version, and age checks before persistence.
 *
 * @param params Source peer slug, local node target, and inbound events payload.
 * @returns Summary counts plus rejection reasons by event index.
 * @throws {Error} Throws when peer/trust/public-key prerequisites are missing and on database failures.
 * @example
 * ```ts
 * const result = await importFederationEvents({
 *   localNodeId: "node-local",
 *   fromPeerSlug: "peer-a",
 *   events: [{ entityType: "agent", eventType: "upsert", visibility: "public", payload: { id: "a1" } }],
 * });
 * ```
 */
export async function importFederationEvents(params: {
  localNodeId: string;
  fromPeerSlug: string;
  events: Array<{
    id?: string;
    entityType: string;
    eventType: string;
    visibility: VisibilityLevel;
    payload: Record<string, unknown>;
    signature?: string;
    nonce?: string;
    eventVersion?: number;
    createdAt?: string;
  }>;
}) {
  // Peer slug is treated as identity input; unknown peers are rejected before any writes.
  const peerNode = await db.query.nodes.findFirst({ where: eq(nodes.slug, params.fromPeerSlug) });
  if (!peerNode) {
    throw new Error(`Unknown peer node: ${params.fromPeerSlug}`);
  }

  const trustedLink = await db.query.nodePeers.findFirst({
    where: and(
      eq(nodePeers.localNodeId, params.localNodeId),
      eq(nodePeers.peerNodeId, peerNode.id),
      eq(nodePeers.trustState, "trusted")
    ),
  });

  if (!trustedLink) {
    throw new Error(`Peer ${params.fromPeerSlug} is not trusted`);
  }

  if (!peerNode.publicKey) {
    // Signature verification cannot be performed without the registered peer public key.
    throw new Error(`Peer ${params.fromPeerSlug} has no public key registered; cannot verify signatures`);
  }

  const imports: NewFederationEventRecord[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < params.events.length; i++) {
    const event = params.events[i];
    // Private visibility never crosses federation boundaries by policy.
    if (!EXPORTABLE_VISIBILITIES.has(event.visibility)) continue;

    // Verify cryptographic signature
    if (!event.signature) {
      rejected.push({ index: i, reason: "missing signature" });
      console.warn(
        `[federation] Rejected event ${i} from ${params.fromPeerSlug}: missing signature`
      );
      continue;
    }

    const signatureValid = verifyPayloadSignature(
      event.payload,
      event.signature,
      peerNode.publicKey
    );

    if (!signatureValid) {
      rejected.push({ index: i, reason: "invalid signature" });
      console.warn(
        `[federation] Rejected event ${i} from ${params.fromPeerSlug}: invalid signature`
      );
      continue;
    }

    // Replay protection: reject duplicate nonces (idempotent)
    if (event.nonce) {
      const existingNonce = await db.query.federationEvents.findFirst({
        where: eq(federationEvents.nonce, event.nonce),
        columns: { id: true },
      });
      if (existingNonce) {
        rejected.push({ index: i, reason: "duplicate nonce" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: duplicate nonce ${event.nonce}`
        );
        continue;
      }
    }

    // Version check: only apply events with version > current for the entity
    if (event.eventVersion != null && typeof event.payload.id === "string") {
      const latestEvent = await db.query.federationEvents.findFirst({
        where: and(
          eq(federationEvents.originNodeId, peerNode.id),
          eq(federationEvents.entityType, event.entityType),
          eq(federationEvents.entityId, event.payload.id as string),
          gt(federationEvents.eventVersion, 0),
        ),
        orderBy: [desc(federationEvents.eventVersion)],
        columns: { eventVersion: true },
      });
      if (latestEvent?.eventVersion != null && event.eventVersion <= latestEvent.eventVersion) {
        rejected.push({ index: i, reason: "stale version" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: stale version ${event.eventVersion} <= ${latestEvent.eventVersion}`
        );
        continue;
      }
    }

    // Time window check: reject events older than the replay window
    if (event.createdAt) {
      const eventTime = new Date(event.createdAt).getTime();
      const cutoff = Date.now() - EVENT_REPLAY_WINDOW_MS;
      // Reject events outside the replay window to reduce delayed replay attack surface.
      if (eventTime < cutoff) {
        rejected.push({ index: i, reason: "expired" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: event too old (created ${event.createdAt})`
        );
        continue;
      }
    }

    imports.push({
      originNodeId: peerNode.id,
      targetNodeId: params.localNodeId,
      entityType: event.entityType,
      eventType: event.eventType,
      visibility: event.visibility,
      payload: event.payload,
      signature: event.signature,
      nonce: event.nonce ?? null,
      eventVersion: event.eventVersion ?? null,
      status: "imported",
      processedAt: new Date(),
    });

    // Best-effort materialization into local read model with namespace mapping.
    // Remote entity IDs are mapped to local UUIDs via federation_entity_map
    // to prevent ID collisions with local entities.
    if (event.entityType === "agent" && event.eventType === "upsert") {
      const payload = event.payload;
      const externalId = typeof payload.id === "string" ? payload.id : null;
      const name = typeof payload.name === "string" ? payload.name : null;
      const type = typeof payload.type === "string" ? payload.type : null;
      if (externalId && name && type) {
        const localId = await resolveLocalEntityId(peerNode.id, externalId, "agent");

        const sourceMetadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
        const metadataWithAttribution = {
          ...sourceMetadata,
          sourceNodeId: peerNode.id,
          sourceNodeSlug: peerNode.slug,
          externalEntityId: externalId,
        };

        await db
          .insert(agents)
          .values({
            id: localId,
            name,
            type: type as typeof agents.$inferInsert.type,
            visibility: event.visibility,
            description: typeof payload.description === "string" ? payload.description : null,
            image: typeof payload.image === "string" ? payload.image : null,
            metadata: metadataWithAttribution,
            parentId: typeof payload.parentId === "string" ? payload.parentId : null,
            pathIds: Array.isArray(payload.pathIds) ? (payload.pathIds as string[]) : null,
          })
          .onConflictDoNothing({ target: agents.id });
      }
    }

    if (event.entityType === "resource" && event.eventType === "upsert") {
      const payload = event.payload;
      const externalId = typeof payload.id === "string" ? payload.id : null;
      const name = typeof payload.name === "string" ? payload.name : null;
      const type = typeof payload.type === "string" ? payload.type : null;
      const externalOwnerId = typeof payload.ownerId === "string" ? payload.ownerId : null;

      if (externalId && name && type && externalOwnerId) {
        // Resolve the owner's local ID via the entity map
        const localOwnerId = await resolveLocalEntityId(peerNode.id, externalOwnerId, "agent");
        const owner = await db.query.agents.findFirst({ where: eq(agents.id, localOwnerId) });
        if (!owner) {
          // Skip orphaned resources until their owner has been imported.
          continue;
        }

        const localId = await resolveLocalEntityId(peerNode.id, externalId, "resource");

        const sourceMetadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
        const metadataWithAttribution = {
          ...sourceMetadata,
          sourceNodeId: peerNode.id,
          sourceNodeSlug: peerNode.slug,
          externalEntityId: externalId,
        };

        await db
          .insert(resources)
          .values({
            id: localId,
            name,
            type: type as typeof resources.$inferInsert.type,
            ownerId: localOwnerId,
            visibility: event.visibility,
            description: typeof payload.description === "string" ? payload.description : null,
            metadata: metadataWithAttribution,
            tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
          })
          .onConflictDoNothing({ target: resources.id });
      }
    }
  }

  // Store rejected events as dead letters in the federation_events table.
  // Nullify the nonce for dead-letter records to avoid unique constraint
  // violations (the original nonce may already exist for "duplicate nonce" rejections).
  for (const rejection of rejected) {
    const event = params.events[rejection.index];
    const [deadLetterEvent] = await db
      .insert(federationEvents)
      .values({
        originNodeId: peerNode.id,
        targetNodeId: params.localNodeId,
        entityType: event.entityType,
        eventType: event.eventType,
        visibility: event.visibility,
        payload: event.payload,
        signature: event.signature ?? null,
        nonce: null,
        eventVersion: event.eventVersion ?? null,
        status: "failed",
        error: rejection.reason,
      })
      .returning();

    await logFederationAudit({
      eventType: "import",
      nodeId: params.localNodeId,
      peerNodeId: peerNode.id,
      federationEventId: deadLetterEvent.id,
      status: "rejected",
      detail: {
        reason: rejection.reason,
        eventIndex: rejection.index,
        entityType: event.entityType,
        originalNonce: event.nonce,
      },
    });
  }

  if (imports.length === 0) {
    return { imported: 0, rejected: rejected.length, rejections: rejected };
  }

  const importedEvents = await db.insert(federationEvents).values(imports).returning();

  for (const event of importedEvents) {
    await logFederationAudit({
      eventType: "import",
      nodeId: params.localNodeId,
      peerNodeId: peerNode.id,
      federationEventId: event.id,
      status: "success",
      detail: {
        entityType: event.entityType,
        entityId: event.entityId,
        eventVersion: event.eventVersion,
        visibility: event.visibility,
      },
    });
  }

  return { imported: imports.length, rejected: rejected.length, rejections: rejected };
}

/**
 * List queued exportable events for an origin node, optionally scoped to one target peer.
 *
 * @param params Origin node, optional peer slug filter, and optional limit.
 * @returns Queued federation events in descending creation order.
 * @throws {Error} May propagate database lookup/query errors.
 * @example
 * ```ts
 * const events = await listExportableEvents({ originNodeId: "node-1", limit: 50 });
 * ```
 */
export async function listExportableEvents(params: {
  originNodeId: string;
  targetNodeSlug?: string;
  limit?: number;
}) {
  let targetNodeId: string | undefined;

  if (params.targetNodeSlug) {
    const target = await db.query.nodes.findFirst({ where: eq(nodes.slug, params.targetNodeSlug) });
    if (target) targetNodeId = target.id;
  }

  // Targeted export sends all queued events for that peer; untargeted export excludes private visibility.
  const whereClause = targetNodeId
    ? and(
        eq(federationEvents.originNodeId, params.originNodeId),
        eq(federationEvents.status, "queued"),
        eq(federationEvents.targetNodeId, targetNodeId)
      )
    : and(
        eq(federationEvents.originNodeId, params.originNodeId),
        eq(federationEvents.status, "queued"),
        ne(federationEvents.visibility, "private")
      );

  return db.query.federationEvents.findMany({
    where: whereClause,
    orderBy: [desc(federationEvents.createdAt)],
    limit: params.limit ?? 100,
  });
}

// ---------------------------------------------------------------------------
// Peer credential management
// ---------------------------------------------------------------------------

/**
 * Rotate the shared secret for a specific peer. Generates a new secret,
 * increments the version, and returns the new plaintext secret (shown once).
 * The old secret is immediately invalidated.
 *
 * @param params Local node + peer relationship and optional credential expiry.
 * @returns New one-time plaintext secret and incremented secret version.
 * @throws {Error} Throws when the peer relationship does not exist or on database failures.
 * @example
 * ```ts
 * const rotated = await rotatePeerSecret({ localNodeId: "node-1", peerNodeId: "node-2" });
 * ```
 */
export async function rotatePeerSecret(params: {
  localNodeId: string;
  peerNodeId: string;
  expiresAt?: Date;
}): Promise<{ secret: string; version: number }> {
  const peerLink = await db.query.nodePeers.findFirst({
    where: and(
      eq(nodePeers.localNodeId, params.localNodeId),
      eq(nodePeers.peerNodeId, params.peerNodeId),
    ),
  });

  if (!peerLink) {
    throw new Error("Peer relationship not found");
  }

  const { secret, hash } = generatePeerSecret();
  // Version increments support deterministic credential rollover tracking and auditability.
  const nextVersion = (peerLink.secretVersion ?? 0) + 1;
  const now = new Date();

  await db
    .update(nodePeers)
    .set({
      peerSecretHash: hash,
      secretVersion: nextVersion,
      secretRotatedAt: now,
      secretExpiresAt: params.expiresAt ?? null,
      updatedAt: now,
    })
    .where(eq(nodePeers.id, peerLink.id));

  await logFederationAudit({
    eventType: "peer_rotate",
    nodeId: params.localNodeId,
    peerNodeId: params.peerNodeId,
    status: "success",
    detail: {
      previousVersion: peerLink.secretVersion ?? 0,
      newVersion: nextVersion,
      hasExpiry: params.expiresAt != null,
    },
  });

  return { secret, version: nextVersion };
}

/**
 * Revoke a peer's credentials without removing the trust relationship.
 * The peer will be unable to authenticate via per-peer secrets until
 * new credentials are generated via `rotatePeerSecret`.
 *
 * @param params Local/peer relationship identifiers.
 * @returns Resolves once credentials are revoked and audit log is written.
 * @throws {Error} Throws when the peer relationship does not exist or on database failures.
 * @example
 * ```ts
 * await revokePeerCredentials({ localNodeId: "node-1", peerNodeId: "node-2" });
 * ```
 */
export async function revokePeerCredentials(params: {
  localNodeId: string;
  peerNodeId: string;
}): Promise<void> {
  const peerLink = await db.query.nodePeers.findFirst({
    where: and(
      eq(nodePeers.localNodeId, params.localNodeId),
      eq(nodePeers.peerNodeId, params.peerNodeId),
    ),
  });

  if (!peerLink) {
    throw new Error("Peer relationship not found");
  }

  await db
    .update(nodePeers)
    .set({
      peerSecretHash: null,
      secretExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(nodePeers.id, peerLink.id));

  await logFederationAudit({
    eventType: "peer_revoke",
    nodeId: params.localNodeId,
    peerNodeId: params.peerNodeId,
    status: "success",
    detail: {
      revokedVersion: peerLink.secretVersion ?? 0,
    },
  });
}

// ── Federation Module Re-exports ──────────────────────────────────────
// New federation infrastructure lives in src/lib/federation/ directory.
// Re-exported here so `@/lib/federation` resolves these exports.
export { getInstanceConfig, isGlobalInstance, getGlobalInstanceId, resetInstanceConfig } from './federation/instance-config';
export type { InstanceConfig, InstanceType } from './federation/instance-config';
export { resolveHomeInstance, listInstances } from './federation/resolution';
export type { HomeInstanceInfo } from './federation/resolution';
export { emitDomainEvent, EVENT_TYPES } from './federation/domain-events';
export type { DomainEvent, EventType } from './federation/domain-events';
export { UpdateFacade, updateFacade } from './federation/update-facade';
export type { Mutation, MutationResult } from './federation/update-facade';
export { QueryFacade, queryFacade } from './federation/query-facade';
export type { QueryResult, DataSource } from './federation/query-facade';
