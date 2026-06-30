import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import crypto from "crypto";
import {
  agents,
  federationEntityMap,
  federationEvents,
  ledger,
  nodePeers,
  nodes,
  resources,
  type ResourceEmbed,
  type NewFederationEventRecord,
  type NewLedgerEntry,
  type NewNodePeerRecord,
  type NewNodeRecord,
  type NodeRole,
  type VisibilityLevel,
} from "@/db/schema";
import { isGroupAgentType } from "@/lib/agent-types";
import {
  generateNodeKeyPair,
  signPayload,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";
import { generatePeerSecret } from "@/lib/federation-auth";
import { logFederationAudit } from "@/lib/federation-audit";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  buildResourceManifestReferenceInput,
  tombstoneManifestReference,
  upsertManifestReference,
} from "@/lib/federation/manifest-references";
import { isGroupMember } from "@/app/actions/group-admin";

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

/**
 * Event types that the resource materializer treats as upsert-equivalent.
 *
 * `upsert` is the legacy/local export verb; `*.created` and `*.updated`
 * are the verbs that `emitDomainEvent` uses on rivr-person and other
 * sovereign apps. Accepting both keeps cross-app federation working
 * without forcing peers to translate event types before sending.
 */
const RESOURCE_UPSERT_EVENT_TYPES = new Set<string>([
  "upsert",
  "resource.created",
  "resource.updated",
  "event.created",
  "event.updated",
]);

/**
 * Event types that the resource materializer treats as soft-delete.
 *
 * The materializer marks the local mirror row's `deletedAt` to now;
 * if no mirror exists yet (delete arrived before the create), the
 * branch is a no-op so the row stays absent rather than getting
 * tombstoned out of order.
 */
const RESOURCE_DELETE_EVENT_TYPES = new Set<string>([
  "resource.deleted",
  "event.deleted",
]);

/**
 * Env var holding this instance's primary agent id (in the local
 * namespace). Used by the importer's resource-scope filter to decide
 * whether a peer-emitted resource event targets this instance.
 *
 * When unset, the filter is permissive — legacy behavior — so
 * deployments must set it explicitly to opt into strict scoping.
 */
const PRIMARY_AGENT_ID_ENV = "PRIMARY_AGENT_ID";

/**
 * Extract candidate scope target ids (in the peer's namespace) from a
 * resource-event payload. The materializer maps each through
 * `federation_entity_map` to its local id and compares to the
 * configured `PRIMARY_AGENT_ID`.
 *
 * Recognized payload shapes:
 *   - `payload.metadata.scopedGroupIds: string[]`
 *   - `payload.metadata.groupId: string`
 *
 * `payload.ownerId` is appended by the caller — it is also a valid
 * scope target (the resource is owned by this instance's primary agent).
 */
function collectScopedExternalAgentIds(payload: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const metadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : null;
  if (metadata) {
    const scoped = metadata.scopedGroupIds;
    if (Array.isArray(scoped)) {
      for (const id of scoped) {
        if (typeof id === "string" && id.length > 0) out.add(id);
      }
    }
    const groupId = metadata.groupId;
    if (typeof groupId === "string" && groupId.length > 0) {
      out.add(groupId);
    }
  }
  return out;
}

function normalizeAuthorityUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function authorityFieldMatches(
  value: unknown,
  expected: string | null,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0 || !expected) return true;
  const normalized = normalizeAuthorityUrl(value.trim());
  return normalized === null || normalized === expected;
}

function payloadSourceMatchesPeer(
  payload: Record<string, unknown>,
  peerNode: { id: string; slug: string; baseUrl: string },
): boolean {
  const metadata = payload.metadata && typeof payload.metadata === "object"
    ? (payload.metadata as Record<string, unknown>)
    : {};
  const expectedBaseUrl = normalizeAuthorityUrl(peerNode.baseUrl);

  if (typeof metadata.sourceNodeId === "string" && metadata.sourceNodeId !== peerNode.id) return false;
  if (typeof metadata.sourceNodeSlug === "string" && metadata.sourceNodeSlug !== peerNode.slug) return false;
  if (!authorityFieldMatches(payload.homeBaseUrl, expectedBaseUrl)) return false;
  if (!authorityFieldMatches(payload.baseUrl, expectedBaseUrl)) return false;
  if (!authorityFieldMatches(metadata.homeBaseUrl, expectedBaseUrl)) return false;
  if (!authorityFieldMatches(metadata.sourceBaseUrl, expectedBaseUrl)) return false;
  if (!authorityFieldMatches(metadata.originBaseUrl, expectedBaseUrl)) return false;
  if (!authorityFieldMatches(metadata.canonicalHomeBaseUrl, expectedBaseUrl)) return false;

  return true;
}

/**
 * Map an instance-config `instanceType` to the `node_role` vocabulary.
 *
 * The two enums diverge: instance types are
 * global/person/group/locale/region while node roles are
 * group/locale/basin/global. Region instances federate as `basin`-role
 * nodes, and person instances (which have no dedicated node role) federate
 * under the `group` role.
 */
function instanceTypeToNodeRole(instanceType: string): NodeRole {
  switch (instanceType) {
    case "global":
      return "global";
    case "locale":
      return "locale";
    case "group":
      return "group";
    case "region":
      return "basin";
    case "person":
      return "group";
    default:
      return DEFAULT_NODE_ROLE;
  }
}

function getNodeSlug(): string {
  // Slug is a stable node identifier used in routing and peer lookup. It must
  // agree with the instance identity (`INSTANCE_SLUG`) so that the local node
  // row created/looked-up here matches the slug peers use in x-peer-slug and
  // the slug the registry advertises. `NODE_SLUG` remains an explicit override.
  return process.env.NODE_SLUG?.trim() || getInstanceConfig().instanceSlug;
}

function getNodeDisplayName(): string {
  // Human-readable display value shown in federation admin views.
  return process.env.NODE_DISPLAY_NAME?.trim() || getInstanceConfig().instanceSlug;
}

function getNodeRole(): NodeRole {
  const role = process.env.NODE_ROLE?.trim() as NodeRole | undefined;
  // Guard against unsupported runtime values even if environment is misconfigured.
  if (role && ["group", "locale", "basin", "global"].includes(role)) {
    return role;
  }
  // Derive from the configured instance type so the local node row's role
  // reflects what kind of instance this actually is, instead of defaulting
  // every unconfigured sovereign to "global".
  return instanceTypeToNodeRole(getInstanceConfig().instanceType);
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
  const configuredInstanceId = getInstanceConfig().instanceId;

  // Resolve the local self-node row. Prefer the slug match, but fall back to
  // the row anchored on the configured instance id. A self-node bootstrapped
  // before NODE_SLUG/INSTANCE_SLUG agreed (e.g. under the legacy "global-host"
  // default, or seeded with a basin slug while INSTANCE_SLUG names the
  // instance) carries the configured id but a stale slug; without this
  // fallback ensureLocalNode would miss it and attempt an insert that collides
  // on the primary key (nodes_pkey), 500ing every federation export.
  const bySlug = await db.query.nodes.findFirst({
    where: eq(nodes.slug, slug),
  });
  const existing =
    bySlug ??
    (await db.query.nodes.findFirst({
      where: eq(nodes.id, configuredInstanceId),
    }));

  if (existing) {
    if (existing.id !== configuredInstanceId) {
      // The signers (SSO, authority events, recovery) and the write-router
      // all look the local node up by config.instanceId. A slug-matched row
      // with a different id means this instance was bootstrapped before
      // INSTANCE_ID was configured; signing and local-write resolution will
      // fail until the operator reconciles the nodes row id with INSTANCE_ID.
      console.error(
        `[federation] Local node slug "${slug}" exists with id ${existing.id}, ` +
          `but INSTANCE_ID is ${configuredInstanceId}. Migrate the nodes row id ` +
          `(and its FK references) to match INSTANCE_ID, or fix the env.`,
      );
    }

    // Reconcile the id-anchored self-node's external identity to the configured
    // values when it has drifted (stale slug/role/displayName/baseUrl from an
    // earlier bootstrap). Only the row that already owns the configured id is
    // safe to relabel this way; a slug-only match with a foreign id is left
    // for the operator (logged above).
    const needsIdentityReconcile =
      existing.id === configuredInstanceId &&
      (existing.slug !== slug ||
        existing.role !== getNodeRole() ||
        existing.baseUrl !== getBaseUrl());
    // Backfill keys for legacy nodes so all exported events can be signed.
    const needsKeys = !existing.privateKey || !existing.publicKey;

    if (needsIdentityReconcile || needsKeys) {
      const keyPair = needsKeys ? generateNodeKeyPair() : null;
      const [updated] = await db
        .update(nodes)
        .set({
          ...(needsIdentityReconcile
            ? {
                slug,
                role: getNodeRole(),
                displayName: getNodeDisplayName(),
                baseUrl: getBaseUrl(),
              }
            : {}),
          ...(keyPair
            ? {
                publicKey: keyPair.publicKey,
                privateKey: keyPair.privateKey,
              }
            : {}),
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
    // Anchor the bootstrap row to the configured instance id so id-based
    // lookups (signers, resolution, write-router) agree with slug-based ones.
    id: configuredInstanceId,
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
 * Read-only federation status for THIS instance's hosted node, for UI probes
 * such as the composer's federate-on-post toggle. Unlike {@link ensureLocalNode}
 * it NEVER bootstraps a node row as a side effect of a status read: if no local
 * self-node exists yet it reports `enabled: false` so the UI degrades to
 * "unavailable" instead of provisioning a node from a GET.
 *
 * @returns `{ enabled }`, plus `node` ({slug, baseUrl}) and `metrics`
 *   ({queuedEvents, trustedPeers}) when a local node exists.
 */
export async function getLocalNodeFederationStatus(): Promise<{
  enabled: boolean;
  node?: { slug: string; baseUrl: string };
  metrics?: { queuedEvents: number; trustedPeers: number };
}> {
  const slug = getNodeSlug();
  const configuredInstanceId = getInstanceConfig().instanceId;
  const localNode =
    (await db.query.nodes.findFirst({ where: eq(nodes.slug, slug) })) ??
    (await db.query.nodes.findFirst({ where: eq(nodes.id, configuredInstanceId) }));
  if (!localNode) return { enabled: false };

  const metrics = await getFederationStatus(localNode.id);
  return {
    enabled: true,
    node: { slug: localNode.slug, baseUrl: localNode.baseUrl },
    metrics: {
      queuedEvents: metrics.queuedEvents,
      trustedPeers: metrics.trustedPeers,
    },
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

  const localHomeBaseUrl = normalizeBaseUrl(getInstanceConfig().baseUrl);
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
        metadata: stampExportedGroupHome(agent.type, agent.metadata, localHomeBaseUrl),
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

/** Canonical UUID shape — entity ids in this ecosystem are per-instance UUIDs. */
const ENTITY_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a remote entity ID to a local UUID via the federation_entity_map table.
 *
 * When no mapping exists yet, the new local id is the EXTERNAL id itself (not a
 * fresh random UUID). This converges the two paths that materialize a remote
 * actor on this sovereign (H2 owner-id split): the importer's agent
 * materializer keys the local row by this resolved id, while the federated-viewer
 * projection (`ensureLocalActorAgent` in actor-projection.ts) keys its
 * placeholder by the visitor's OWN id — the same external UUID the home peer
 * later federates. Minting a random local id here produced a SECOND, divergent
 * agent row for one remote actor (the duplicate-agent bug); keying both on the
 * external id makes the importer upgrade the projection's placeholder in place.
 * Falls back to a random UUID only for the defensive (not-expected-in-this-
 * ecosystem) case where the external id is not a valid UUID, since
 * `local_entity_id` is a `uuid` column.
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

  const localEntityId = ENTITY_ID_UUID_PATTERN.test(externalEntityId)
    ? externalEntityId
    : crypto.randomUUID();
  await db
    .insert(federationEntityMap)
    .values({
      originNodeId,
      externalEntityId,
      localEntityId,
      entityType,
    })
    .onConflictDoNothing({
      target: [
        federationEntityMap.originNodeId,
        federationEntityMap.externalEntityId,
        federationEntityMap.entityType,
      ],
    });

  return localEntityId;
}

/**
 * Ensures a local `agents` row exists for a mapped remote agent id.
 *
 * Real-time resource events can arrive before the owning agent's upsert
 * event from the same peer. Instead of silently dropping the resource
 * (the historical behavior), project a minimal private placeholder agent.
 * The next agent upsert for the same entity from that peer upgrades the
 * placeholder in place via the materializer's placeholder-upgrade path.
 */
async function ensureProjectedAgent(params: {
  localAgentId: string;
  externalAgentId: string;
  peerNode: { id: string; slug: string };
}): Promise<void> {
  const existing = await db.query.agents.findFirst({
    where: eq(agents.id, params.localAgentId),
    columns: { id: true },
  });
  if (existing) return;

  await db
    .insert(agents)
    .values({
      id: params.localAgentId,
      name: `Federated agent (${params.peerNode.slug})`,
      type: "person",
      visibility: "private",
      metadata: {
        federatedPlaceholder: true,
        sourceNodeId: params.peerNode.id,
        sourceNodeSlug: params.peerNode.slug,
        externalEntityId: params.externalAgentId,
      },
    })
    .onConflictDoNothing({ target: agents.id });
}

/** Strips a trailing slash from a base URL for stable comparison/storage. */
function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "");
}

/**
 * Stamps this instance's base URL as the `homeBaseUrl` on a locally-owned group
 * agent's exported metadata, so the canonical home travels with the card and
 * survives a relay hop through the global hub (peers can't reliably infer it
 * from the sending node otherwise). No-op for non-group agents, agents already
 * carrying a home, and foreign (federated) rows we don't own.
 */
function stampExportedGroupHome(
  agentType: string,
  metadata: Record<string, unknown> | null | undefined,
  localHomeBaseUrl: string,
): Record<string, unknown> | null | undefined {
  if (!isGroupAgentType(agentType)) return metadata;
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.sourceNodeId === "string" && meta.sourceNodeId) return metadata;
  const existing =
    (typeof meta.homeBaseUrl === "string" && meta.homeBaseUrl) ||
    (typeof meta.canonicalUrl === "string" && meta.canonicalUrl);
  if (existing) return metadata;
  return { ...meta, homeBaseUrl: localHomeBaseUrl };
}

/**
 * Ensures a federated group agent carries a canonical `homeBaseUrl` so the
 * no-mirror self-view redirect and membership links resolve to the sovereign
 * group instance rather than the relaying hub.
 *
 * Precedence:
 *  1. A home stamped by the origin (`homeBaseUrl`/`canonicalUrl` in the payload)
 *     — relay-safe, survives a hop through the global hub.
 *  2. The direct peer's base URL, but ONLY when that peer is the home itself
 *     (never the `global` relay, whose URL would mislabel the home).
 */
function ensureGroupHomeBaseUrl(
  metadata: Record<string, unknown>,
  peerNode: { baseUrl: string; role: NodeRole },
): Record<string, unknown> {
  const stamped =
    (typeof metadata.homeBaseUrl === "string" && metadata.homeBaseUrl) ||
    (typeof metadata.canonicalUrl === "string" && metadata.canonicalUrl) ||
    null;
  if (stamped) return metadata;
  if (peerNode.role !== "global" && peerNode.baseUrl) {
    return { ...metadata, homeBaseUrl: normalizeBaseUrl(peerNode.baseUrl) };
  }
  return metadata;
}

/** Extracts the admin/member roster from a group agent's metadata. */
function extractGroupRoster(metadata: Record<string, unknown>): {
  adminIds: string[];
  memberIds: string[];
} {
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  return {
    adminIds: asStringArray(metadata.adminIds),
    memberIds: asStringArray(metadata.memberIds),
  };
}

/**
 * Read-only resolution of roster agent IDs to their canonical LOCAL ids via
 * existing `federation_entity_map` aliases.
 *
 * A federated group card carries its roster in the SENDING instance's id space
 * (e.g. the group's home knows this instance's owner under a different local
 * person id). When the same human already has a `local_alias` mapping here —
 * the de-dupe link between a remote projection and the canonical local agent —
 * we collapse the roster onto the local id so membership predicates, role
 * display, and owner recognition all resolve to one identity instead of a
 * duplicate. IDs without an existing alias pass through unchanged; this never
 * mints new mappings or placeholder agents.
 */
async function normalizeRosterToLocalIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const unique = [...new Set(ids)];
  const rows = await db.query.federationEntityMap.findMany({
    where: and(
      inArray(federationEntityMap.externalEntityId, unique),
      eq(federationEntityMap.entityType, "agent"),
    ),
  });
  if (rows.length === 0) return ids;
  const aliasToLocal = new Map(
    rows.map((r) => [r.externalEntityId, r.localEntityId]),
  );
  return ids.map((id) => aliasToLocal.get(id) ?? id);
}

/**
 * Projects this instance owner's membership in a federated group as a local
 * `belong` ledger edge so every membership predicate (group lists, member
 * counts, group-wallet access) resolves it — not just the metadata roster.
 *
 * Additive only: presence in the roster grants/refreshes the edge. Absence is
 * NOT treated as removal here, because a federated card's roster may be partial
 * or membership may be carried as ledger edges on the group's home; deactivation
 * must be driven by an explicit membership-removal event, not roster absence.
 */
async function reconcileImportedGroupMembership(params: {
  groupId: string;
  roster: { adminIds: string[]; memberIds: string[] };
  primaryAgentId: string | null;
  sourceNodeId: string;
  sourceNodeSlug: string;
}): Promise<void> {
  const { groupId, roster, primaryAgentId, sourceNodeId, sourceNodeSlug } =
    params;
  if (!primaryAgentId) return;

  const isAdmin = roster.adminIds.includes(primaryAgentId);
  const isMember = isAdmin || roster.memberIds.includes(primaryAgentId);
  if (!isMember) return;

  const role = isAdmin ? "admin" : "member";

  const existing = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, primaryAgentId),
      eq(ledger.objectId, groupId),
      eq(ledger.objectType, "agent"),
      inArray(ledger.verb, ["join", "belong"]),
    ),
  });

  if (existing) {
    if (existing.isActive !== true || existing.role !== role) {
      await db
        .update(ledger)
        .set({ isActive: true, role })
        .where(eq(ledger.id, existing.id));
    }
    return;
  }

  await db.insert(ledger).values({
    verb: "belong",
    subjectId: primaryAgentId,
    objectId: groupId,
    objectType: "agent",
    role,
    isActive: true,
    metadata: {
      grantType: "federated_membership",
      sourceNodeId,
      sourceNodeSlug,
      interactionType: "membership",
      targetId: groupId,
      targetType: "group",
      grantedAt: new Date().toISOString(),
    },
  } as NewLedgerEntry);
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
    entityId?: string | null;
    entityType: string;
    eventType: string;
    visibility: VisibilityLevel;
    payload: Record<string, unknown>;
    signature?: string;
    nonce?: string;
    eventVersion?: number;
    createdAt?: string;
  }>;
  /**
   * Accept events older than EVENT_REPLAY_WINDOW_MS. Only the locally
   * initiated cursor-based pull sync may set this: the pull path fetches
   * directly from the trusted peer over HTTPS and is already protected by
   * signature verification + nonce dedup, and without it any downtime
   * longer than the window permanently skips the backlog (the cursor
   * advances past events the import rejected as expired). Inbound push
   * routes must NEVER set this — the strict window bounds replay of
   * intercepted signed events there.
   */
  allowHistorical?: boolean;
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

    // Origin-namespace entity id: prefer the envelope's entityId, fall back
    // to payload.id (matches global/person import behavior).
    const eventEntityId =
      typeof event.entityId === "string"
        ? event.entityId
        : typeof event.payload.id === "string"
          ? event.payload.id
          : null;

    // Local-home conflict guard (federation loop-back protection).
    //
    // If THIS instance authored the resource carrying `eventEntityId` — i.e. a
    // federation event with our own node as origin already exists for it — then
    // the resource is sovereign-homed HERE. An inbound event attributing the
    // SAME id to a peer origin is a loop-back: the owner's agent can be
    // entity-mapped (`mirrored_remote`) to a peer node, so our own exported
    // `*.created`/`upsert` echoes back through pull-sync as a peer-origin
    // import. Re-homing it would stamp a foreign `canonicalUrl` + write an
    // active `manifest_reference`, and the sovereign-resource redirect would
    // then bounce the resource off its real home to a logged-out peer page.
    // Reject before any materialization. Scoped to resources: agents/groups can
    // legitimately be sovereign-homed on a peer and mirrored here, so this never
    // blocks their import.
    if (
      event.entityType === "resource" &&
      eventEntityId &&
      peerNode.id !== params.localNodeId
    ) {
      const selfAuthored = await db.query.federationEvents.findFirst({
        where: and(
          eq(federationEvents.originNodeId, params.localNodeId),
          eq(federationEvents.entityType, "resource"),
          eq(federationEvents.entityId, eventEntityId),
        ),
        columns: { id: true },
      });
      if (selfAuthored) {
        rejected.push({ index: i, reason: "local-home conflict (loop-back)" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: resource ${eventEntityId} is locally homed (self-authored); refusing peer re-home`
        );
        continue;
      }
    }

    // Version check: only apply events with version > current for the entity
    if (event.eventVersion != null && eventEntityId) {
      const latestEvent = await db.query.federationEvents.findFirst({
        where: and(
          eq(federationEvents.originNodeId, peerNode.id),
          eq(federationEvents.entityType, event.entityType),
          eq(federationEvents.entityId, eventEntityId),
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

    // Time window check: reject events older than the replay window.
    // Skipped for the locally initiated pull sync (see allowHistorical).
    if (!params.allowHistorical && event.createdAt) {
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

    const importRecord: NewFederationEventRecord = {
      originNodeId: peerNode.id,
      targetNodeId: params.localNodeId,
      // Preserve the origin-namespace entity id so downstream consumers
      // (audit queries, projections, duplicate-upsert conflict resolution)
      // can find the event by the origin's entity id (parity with global).
      entityId: eventEntityId,
      entityType: event.entityType,
      eventType: event.eventType,
      visibility: event.visibility,
      payload: event.payload,
      signature: event.signature,
      nonce: event.nonce ?? null,
      eventVersion: event.eventVersion ?? null,
      status: "imported",
      // Bound to the materialized local agent below (agent upserts bind the
      // agent itself; resource upserts bind the local owner). Stays null for
      // events that don't materialize a local row.
      actorId: null,
      processedAt: new Date(),
    };
    imports.push(importRecord);

    // Best-effort materialization into local read model with namespace mapping.
    // Remote entity IDs are mapped to local UUIDs via federation_entity_map
    // to prevent ID collisions with local entities.
    if (event.entityType === "agent" && event.eventType === "upsert") {
      const payload = event.payload;
      if (!payloadSourceMatchesPeer(payload, peerNode)) {
        rejected.push({ index: i, reason: "source authority mismatch" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: source authority mismatch`
        );
        continue;
      }
      const externalId = typeof payload.id === "string" ? payload.id : null;
      const name = typeof payload.name === "string" ? payload.name : null;
      const type = typeof payload.type === "string" ? payload.type : null;
      if (externalId && name && type) {
        const localId = await resolveLocalEntityId(peerNode.id, externalId, "agent");

        const sourceMetadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
        const baseMetadata = {
          ...sourceMetadata,
          sourceNodeId: peerNode.id,
          sourceNodeSlug: peerNode.slug,
          externalEntityId: externalId,
        };
        // Group agents must travel with a canonical home so no-mirror redirects
        // and membership links resolve to the sovereign group instance.
        const isGroup = isGroupAgentType(type);
        let metadataWithAttribution = isGroup
          ? ensureGroupHomeBaseUrl(baseMetadata, peerNode)
          : baseMetadata;
        // De-dupe identities: express the federated roster in this instance's
        // canonical local id space so the owner (and any aliased member) is
        // recognized as one agent rather than a separate remote projection.
        if (isGroup) {
          const rawRoster = extractGroupRoster(metadataWithAttribution);
          const [adminIds, memberIds] = await Promise.all([
            normalizeRosterToLocalIds(rawRoster.adminIds),
            normalizeRosterToLocalIds(rawRoster.memberIds),
          ]);
          metadataWithAttribution = {
            ...metadataWithAttribution,
            adminIds,
            memberIds,
          };
        }

        const existingAgent = await db.query.agents.findFirst({
          where: eq(agents.id, localId),
          columns: { id: true, metadata: true },
        });
        const existingMeta =
          (existingAgent?.metadata as Record<string, unknown> | null) ?? null;
        const isPlaceholder = existingMeta?.federatedPlaceholder === true;
        // A row this same peer previously projected is safe to refresh in place
        // (e.g. an updated group roster or profile); locally-owned/merged agents
        // — which carry no matching source attribution — are never overwritten.
        const isFederatedFromPeer =
          existingMeta != null && existingMeta.sourceNodeId === peerNode.id;

        if (!existingAgent) {
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
        } else if (isPlaceholder || isFederatedFromPeer) {
          // Upgrade auto-projected placeholder agents and refresh rows
          // previously projected from this same peer (the real remote profile
          // or an updated group roster). Locally merged/owned agents are never
          // overwritten by inbound federation events.
          await db
            .update(agents)
            .set({
              name,
              type: type as typeof agents.$inferInsert.type,
              visibility: event.visibility,
              description: typeof payload.description === "string" ? payload.description : null,
              image: typeof payload.image === "string" ? payload.image : null,
              metadata: metadataWithAttribution,
              parentId: typeof payload.parentId === "string" ? payload.parentId : null,
              pathIds: Array.isArray(payload.pathIds) ? (payload.pathIds as string[]) : null,
              updatedAt: new Date(),
            })
            .where(eq(agents.id, localId));
        }

        // Project the instance owner's membership in a federated group as a
        // local `belong` edge so every membership predicate resolves it.
        if (isGroup) {
          await reconcileImportedGroupMembership({
            groupId: localId,
            roster: extractGroupRoster(metadataWithAttribution),
            primaryAgentId: getInstanceConfig().primaryAgentId ?? null,
            sourceNodeId: peerNode.id,
            sourceNodeSlug: peerNode.slug,
          });
        }

        // Bind the imported event to the materialized local agent for audit.
        importRecord.actorId = localId;
      }
    }

    if (event.entityType === "resource" && RESOURCE_UPSERT_EVENT_TYPES.has(event.eventType)) {
      const payload = event.payload;
      if (!payloadSourceMatchesPeer(payload, peerNode)) {
        rejected.push({ index: i, reason: "source authority mismatch" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: source authority mismatch`
        );
        continue;
      }
      const externalId = typeof payload.id === "string" ? payload.id : null;
      const name = typeof payload.name === "string" ? payload.name : null;
      const type = typeof payload.type === "string" ? payload.type : null;
      const externalOwnerId = typeof payload.ownerId === "string" ? payload.ownerId : null;

      if (externalId && name && type && externalOwnerId) {
        // Resolve the owner's local ID via the entity map.
        const localOwnerId = await resolveLocalEntityId(peerNode.id, externalOwnerId, "agent");

        // Scope filter: only project resources targeting this instance's
        // primary agent. Without this gate, every public Camalot/global
        // resource event would be mirrored into every connected peer.
        //
        // Comparison runs in the local namespace: Camalot's
        // `scopedGroupIds`/`groupId`/`ownerId` are in its own namespace,
        // so we map each through `federation_entity_map` (the same
        // helper `resolveLocalEntityId` already used for the owner lookup
        // above) before checking against `PRIMARY_AGENT_ID`.
        //
        // When `PRIMARY_AGENT_ID` is unset, the filter is permissive
        // (legacy behavior preserved); deployments that want strict
        // scoping must set it explicitly.
        const primaryAgentId = process.env[PRIMARY_AGENT_ID_ENV]?.trim() ?? null;
        if (primaryAgentId) {
          const candidateExternalIds = collectScopedExternalAgentIds(payload);
          // Owner is also a valid scope target (the resource is owned by
          // this instance's primary agent).
          candidateExternalIds.add(externalOwnerId);

          let scopeMatches = false;
          for (const externalScopeId of candidateExternalIds) {
            const localScopeId = await resolveLocalEntityId(
              peerNode.id,
              externalScopeId,
              "agent",
            );
            if (localScopeId === primaryAgentId) {
              scopeMatches = true;
              break;
            }
          }

          if (!scopeMatches) {
            // Persist the federation_event row above for audit/recovery,
            // but do NOT mirror into `resources`. This keeps the local
            // surface scoped to events that target this instance.
            continue;
          }

          // Membership gate: a peer can only project resources scoped to
          // this group when the originating actor is a member of the
          // group locally. Without this gate any trusted peer could
          // federate events claiming arbitrary actors as members of
          // arbitrary local groups, bypassing the group-admin model.
          //
          // The actor is `payload.metadata.creatorId` when set, otherwise
          // the resource owner. Both are mapped through
          // `federation_entity_map` to local agent ids before the check.
          const sourceMetadataForActor =
            (payload.metadata as Record<string, unknown> | undefined) ?? {};
          const declaredCreatorId =
            typeof sourceMetadataForActor.creatorId === "string"
              ? sourceMetadataForActor.creatorId
              : null;
          const externalActorId = declaredCreatorId ?? externalOwnerId;
          const localActorId = await resolveLocalEntityId(
            peerNode.id,
            externalActorId,
            "agent",
          );
          const actorIsMember = await isGroupMember(localActorId, primaryAgentId);
          if (!actorIsMember) {
            console.warn(
              `[federation] Rejected resource ${externalId} from ${peerNode.slug}: actor ${externalActorId} (local ${localActorId}) is not a member of target group ${primaryAgentId}`,
            );
            continue;
          }
        }

        // The event passed scope + membership gates. If the owning agent
        // hasn't been imported yet (real-time create arrived before its
        // owner's upsert), project a placeholder agent so the resource
        // still materializes instead of being silently dropped. The next
        // agent upsert from this peer upgrades the placeholder in place.
        await ensureProjectedAgent({
          localAgentId: localOwnerId,
          externalAgentId: externalOwnerId,
          peerNode,
        });

        const localId = await resolveLocalEntityId(peerNode.id, externalId, "resource");

        const sourceMetadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
        const metadataWithAttribution = {
          ...sourceMetadata,
          sourceNodeId: peerNode.id,
          sourceNodeSlug: peerNode.slug,
          externalEntityId: externalId,
        };

        // Carry the post/resource body and inline embeds from the upsert
        // payload. Without these the mirror row materializes with only a
        // title — the author's text and any linked offering/voucher embed
        // (e.g. a marketplace listing link) are dropped, so a federated
        // post lands in the group feed empty. `embeds` is NOT NULL with a
        // `[]` default; coerce a missing/invalid array to `[]`.
        const content = typeof payload.content === "string" ? payload.content : null;
        const embeds = Array.isArray(payload.embeds)
          ? (payload.embeds as ResourceEmbed[])
          : [];

        // True upsert by stable local id: re-imports update the existing
        // mirror row in place rather than no-op'ing on conflict. This is
        // what makes Camalot edits to the same event propagate to Spirit
        // without creating duplicate resource rows. `id` and `createdAt`
        // are intentionally not in the SET clause so they remain stable.
        await db
          .insert(resources)
          .values({
            id: localId,
            name,
            type: type as typeof resources.$inferInsert.type,
            ownerId: localOwnerId,
            visibility: event.visibility,
            content,
            embeds,
            description: typeof payload.description === "string" ? payload.description : null,
            metadata: metadataWithAttribution,
            tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
          })
          .onConflictDoUpdate({
            target: resources.id,
            set: {
              name,
              type: type as typeof resources.$inferInsert.type,
              ownerId: localOwnerId,
              visibility: event.visibility,
              content,
              embeds,
              description: typeof payload.description === "string" ? payload.description : null,
              metadata: metadataWithAttribution,
              tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
              updatedAt: new Date(),
            },
          });

        // Bind the imported event to the local owner agent for audit.
        importRecord.actorId = localOwnerId;

        // Universal Manifest v0.4: record a reference-mode pointer beside the
        // mirror row so this instance participates in reference-mode discovery
        // and resource detail/checkout pages can redirect to the sovereign
        // origin. Best-effort — a failure here never blocks the mirror import.
        const remoteOwnerName =
          (typeof payload.authorName === "string" && payload.authorName.trim()) ||
          (typeof payload.ownerName === "string" && payload.ownerName.trim()) ||
          null;
        const referenceResult = await upsertManifestReference(
          buildResourceManifestReferenceInput({
            originNodeId: peerNode.id,
            originBaseUrl: peerNode.baseUrl,
            originNodeSlug: peerNode.slug,
            externalEntityId: externalId,
            localEntityId: localId,
            // The federation_events row is bulk-inserted after this loop, so it
            // does not exist yet — leave the FK null rather than reference an
            // unsaved row.
            sourceFederationEventId: null,
            manifestVersion: event.eventVersion ?? null,
            payload: payload as Record<string, unknown>,
            resourceType: type,
            visibility: event.visibility,
            title: name,
            description: typeof payload.description === "string" ? payload.description : null,
            tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
            ownerId: externalOwnerId,
            ownerName: remoteOwnerName,
          }),
        ).catch((error) => {
          console.warn(
            `[federation] manifest_reference upsert failed for resource=${externalId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        });
        if (referenceResult?.status === "stale") {
          console.warn(
            `[federation] skipped stale manifest_reference upsert for resource=${externalId}: ${referenceResult.reason}`,
          );
        }
      }
    }

    if (event.entityType === "resource" && RESOURCE_DELETE_EVENT_TYPES.has(event.eventType)) {
      const payload = event.payload;
      if (!payloadSourceMatchesPeer(payload, peerNode)) {
        rejected.push({ index: i, reason: "source authority mismatch" });
        console.warn(
          `[federation] Rejected event ${i} from ${params.fromPeerSlug}: source authority mismatch`
        );
        continue;
      }

      // Delete events identify the target via `payload.id` (preferred) or
      // fall back to the envelope `entityId`. The mirror row is located
      // through the entity map so namespace-mapped local UUIDs resolve.
      const externalId = typeof payload.id === "string" ? payload.id : eventEntityId;
      if (externalId) {
        const mapping = await db.query.federationEntityMap.findFirst({
          where: and(
            eq(federationEntityMap.originNodeId, peerNode.id),
            eq(federationEntityMap.externalEntityId, externalId),
            eq(federationEntityMap.entityType, "resource"),
          ),
        });
        if (mapping) {
          await db
            .update(resources)
            .set({ deletedAt: new Date() })
            .where(eq(resources.id, mapping.localEntityId));
        }
        // No-op when no mapping exists: the local mirror was never
        // created, so there is nothing to soft-delete. The federation
        // event itself is still persisted above for audit.

        // Universal Manifest v0.4: tombstone the reference-mode pointer so
        // discovery surfaces and origin-redirects stop resolving the removed
        // resource, independent of whether a local mirror existed.
        const tombstoneResult = await tombstoneManifestReference({
          originNodeId: peerNode.id,
          externalEntityId: externalId,
          entityType: "resource",
          manifestVersion: event.eventVersion ?? null,
          sourceFederationEventId: null,
        }).catch((error) => {
          console.warn(
            `[federation] manifest_reference tombstone failed for resource=${externalId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        });
        if (tombstoneResult?.status === "stale") {
          console.warn(
            `[federation] skipped stale manifest_reference tombstone for resource=${externalId}: ${tombstoneResult.reason}`,
          );
        }
      }
    }
  }

  // Log rejected events as a summary warning — do NOT persist them as dead
  // letters in the database. The old pattern of inserting a `status='failed'`
  // row per rejection caused unbounded DB growth (2M+ rows on one instance)
  // when historical pull replayed unsigned events every sync cycle.
  if (rejected.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const r of rejected) {
      reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
    }
    const summary = Array.from(reasonCounts.entries())
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", ");
    console.warn(
      `[federation] Rejected ${rejected.length} events from ${peerNode.slug}: ${summary}`,
    );
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
