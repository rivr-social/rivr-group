// src/lib/federation/resolution.ts

/**
 * Federation resolution module.
 *
 * Resolves which instance is authoritative for a given agent by walking
 * the agent hierarchy (dedicated instance → parent chain → global fallback).
 * Also exposes a registry listing of all known instances.
 */

import { db } from "@/db";
import { nodes, agents, federationEntityMap } from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { getInstanceConfig, getGlobalInstanceId } from "./instance-config";

/** Maximum depth when walking the parent chain to prevent infinite loops. */
const MAX_PARENT_DEPTH = 5;

export interface HomeInstanceInfo {
  nodeId: string;
  instanceType: string;
  slug: string;
  baseUrl: string;
  isLocal: boolean;
  migrationStatus: string;
}

/**
 * Resolve the authoritative home instance for a given agent.
 *
 * Resolution rules:
 * 1. Check if the agent has a dedicated instance (nodes.primaryAgentId = agentId)
 * 2. If not, walk the agent's parent chain (for subgroups/personas)
 * 3. Fallback: global instance
 *
 * Returns instance info including whether it's the current (local) instance.
 */
export async function resolveHomeInstance(agentId: string): Promise<HomeInstanceInfo> {
  return resolveHomeInstanceWithDepth(agentId, 0);
}

async function resolveHomeInstanceWithDepth(
  agentId: string,
  depth: number,
): Promise<HomeInstanceInfo> {
  if (depth > MAX_PARENT_DEPTH) return getGlobalInstanceInfo();

  const config = getInstanceConfig();

  // Direct lookup: is there a node with this agent as primary?
  const directNode = await db
    .select()
    .from(nodes)
    .where(eq(nodes.primaryAgentId, agentId))
    .limit(1);

  if (directNode.length > 0 && directNode[0].migrationStatus !== "archived") {
    const node = directNode[0];
    return {
      nodeId: node.id,
      instanceType: node.instanceType || "global",
      slug: node.slug,
      baseUrl: node.baseUrl,
      isLocal: node.id === config.instanceId,
      migrationStatus: node.migrationStatus || "active",
    };
  }

  // Parent chain / home-stamp: load the agent's parent links and metadata.
  const agent = await db
    .select({
      parentId: agents.parentId,
      parentAgentId: agents.parentAgentId,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (agent.length > 0) {
    // A federated-homed agent may carry only a `homeBaseUrl`/`canonicalUrl`
    // stamp (no node id) — e.g. a federated-viewer projection minted by
    // ensureLocalActorAgent. Consult it so the server-side home guard agrees
    // with the registry API and the client redirect (H1: profile buttons not
    // routing to the sovereign home). The loop guard inside never resolves to
    // us.
    const homeUrlHome = await resolveViaHomeBaseUrlMetadata(agent[0].metadata);
    if (homeUrlHome) {
      return homeUrlHome;
    }

    const parentId = agent[0].parentAgentId || agent[0].parentId;
    if (parentId) {
      return resolveHomeInstanceWithDepth(parentId, depth + 1);
    }
  }

  // Fallback: global instance
  return getGlobalInstanceInfo();
}

/** Strip a trailing slash so base URLs compare/store consistently. */
function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "");
}

/** Compare two URLs by host only, tolerating parse failures. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * Resolve the registered node for a base URL into a {@link HomeInstanceInfo}.
 *
 * Used when the only home signal is a `homeBaseUrl`/`canonicalUrl` stamp (the
 * remote-viewer cookie and federated stamps carry the URL, not the node id).
 * Returns null when no non-archived node is registered for that URL — common on
 * a sovereign, where a visitor's home is reached through the global hub rather
 * than registered locally. Shared with {@link ensureLocalActorAgent} so
 * projection and home resolution agree on one lookup.
 */
export async function resolveHomeByBaseUrl(
  baseUrl: string,
): Promise<HomeInstanceInfo | null> {
  const normalized = normalizeBaseUrl(baseUrl);
  const [node] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.baseUrl, normalized))
    .limit(1);

  if (!node || node.migrationStatus === "archived") return null;

  return {
    nodeId: node.id,
    instanceType: node.instanceType || "person",
    slug: node.slug,
    baseUrl: node.baseUrl,
    isLocal: node.id === getInstanceConfig().instanceId,
    migrationStatus: node.migrationStatus || "active",
  };
}

/**
 * Resolve canonical home from a federated-homed agent's own
 * `homeBaseUrl`/`canonicalUrl` metadata stamp.
 *
 * Prefers the explicit `homeBaseUrl`; otherwise falls back to the origin of
 * `canonicalUrl`. Returns null when no URL stamp is present, when it points back
 * at this instance (loop guard), or when no non-archived node is registered.
 */
async function resolveViaHomeBaseUrlMetadata(
  metadata: unknown,
): Promise<HomeInstanceInfo | null> {
  if (!metadata || typeof metadata !== "object") return null;
  const meta = metadata as Record<string, unknown>;

  const homeBaseUrl =
    (typeof meta.homeBaseUrl === "string" && meta.homeBaseUrl) || null;
  const canonicalUrl =
    (typeof meta.canonicalUrl === "string" && meta.canonicalUrl) || null;

  let candidateBaseUrl = homeBaseUrl;
  if (!candidateBaseUrl && canonicalUrl) {
    try {
      candidateBaseUrl = new URL(canonicalUrl).origin;
    } catch {
      candidateBaseUrl = null;
    }
  }
  if (!candidateBaseUrl) return null;

  const config = getInstanceConfig();
  // Loop guard: a stamp pointing at our own host is local — never redirect to
  // ourselves.
  if (sameHost(candidateBaseUrl, config.baseUrl)) return null;

  const home = await resolveHomeByBaseUrl(candidateBaseUrl).catch(() => null);
  if (!home || home.isLocal || home.nodeId === config.instanceId) return null;
  return home;
}

async function getGlobalInstanceInfo(): Promise<HomeInstanceInfo> {
  const config = getInstanceConfig();
  const globalId = getGlobalInstanceId();

  // Try to find the global node in the DB
  const globalNode = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, globalId))
    .limit(1);

  if (globalNode.length > 0) {
    return {
      nodeId: globalNode[0].id,
      instanceType: "global",
      slug: globalNode[0].slug,
      baseUrl: globalNode[0].baseUrl,
      isLocal: globalNode[0].id === config.instanceId,
      migrationStatus: globalNode[0].migrationStatus || "active",
    };
  }

  // No global node registered yet — assume we ARE the global instance
  return {
    nodeId: globalId,
    instanceType: "global",
    slug: "global",
    baseUrl: config.baseUrl,
    isLocal: true,
    migrationStatus: "active",
  };
}

/**
 * List all registered instances that have an instanceType set.
 * Filters out legacy federation-only nodes that predate the multi-instance model.
 */
export async function listInstances(): Promise<HomeInstanceInfo[]> {
  const config = getInstanceConfig();

  const registryNodes = await db
    .select()
    .from(nodes)
    .where(isNotNull(nodes.instanceType));

  return registryNodes.map((node) => ({
    nodeId: node.id,
    instanceType: node.instanceType || "global",
    slug: node.slug,
    baseUrl: node.baseUrl,
    isLocal: node.id === config.instanceId,
    migrationStatus: node.migrationStatus || "active",
  }));
}

/**
 * Translate a (possibly remote) actor id into THIS instance's local agent id.
 *
 * A federated remote-viewer session (the signed `rivr_remote_viewer` cookie)
 * carries the actor's HOME id verbatim. Before that actor acts locally — writing
 * ledger edges, joining groups, posting — the home id must be normalized to the
 * receiver-local agent so rows bind to a real local principal (no dangling
 * remote `subject_id`, no "Unknown User" roster gaps). This mirrors the
 * peer-secret normalization in `bindAuthorizedFederationActor`
 * (federation-auth.ts), applied to the session/cookie path (GRP-DSN-001).
 *
 * Strict and read-only: never mints a mapping. Returns the mapped
 * `local_entity_id` when a `federation_entity_map` row keys the input as an
 * `external_entity_id` for an `agent`; otherwise returns the input unchanged —
 * it is already a local id (a NextAuth user, or an actor with no federated
 * projection).
 */
export async function resolveLocalActorId(actorId: string): Promise<string> {
  const [mapping] = await db
    .select({ localEntityId: federationEntityMap.localEntityId })
    .from(federationEntityMap)
    .where(
      and(
        eq(federationEntityMap.externalEntityId, actorId),
        eq(federationEntityMap.entityType, "agent"),
      ),
    )
    .limit(1);

  return mapping?.localEntityId || actorId;
}
