// src/lib/federation/resolution.ts

/**
 * Federation resolution module.
 *
 * Resolves which instance is authoritative for a given agent by walking
 * the agent hierarchy (dedicated instance → parent chain → global fallback).
 * Also exposes a registry listing of all known instances.
 */

import { db } from "@/db";
import { nodes, agents } from "@/db/schema";
import { eq, isNotNull } from "drizzle-orm";
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

  // Parent chain: check if this agent's parent has an instance
  const agent = await db
    .select({
      parentId: agents.parentId,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (agent.length > 0) {
    const parentId = agent[0].parentAgentId || agent[0].parentId;
    if (parentId) {
      return resolveHomeInstanceWithDepth(parentId, depth + 1);
    }
  }

  // Fallback: global instance
  return getGlobalInstanceInfo();
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
