/**
 * Shared serialization helpers for graph entities.
 *
 * Extracted from `src/app/actions/graph.ts` so both server actions and the
 * declarative graph-query module can reuse them without circular imports.
 */

import type { Agent, Resource } from "@/db/schema";
import { normalizeAssetUrl } from "@/lib/asset-url";

// ─── Serialized Interfaces ───────────────────────────────────────────────────

export interface SerializedAgent {
  id: string;
  name: string;
  type: string;
  description: string | null;
  email: string | null;
  image: string | null;
  visibility?: string | null;
  metadata: Record<string, unknown>;
  parentId: string | null;
  parentAgentId?: string | null;
  pathIds?: string[];
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedResource {
  id: string;
  name: string;
  type: string;
  description: string | null;
  content: string | null;
  url: string | null;
  ownerId: string;
  isPublic: boolean;
  visibility?: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SerializedPostDetail {
  resource: SerializedResource;
  author: SerializedAgent | null;
}

// ─── Serialization Helpers ───────────────────────────────────────────────────

export function toISOString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

export function toJsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return normalizeAssetUrl(value);
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, val]) => [key, toJsonSafe(val)])
    );
  }
  return value;
}

export function serializeAgent(agent: Agent): SerializedAgent {
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    description: agent.description,
    email: null,
    image: agent.image ? normalizeAssetUrl(agent.image) : null,
    visibility: agent.visibility ?? null,
    metadata: (toJsonSafe(agent.metadata ?? {}) as Record<string, unknown>),
    parentId: agent.parentId,
    parentAgentId: agent.parentAgentId ?? null,
    pathIds: agent.pathIds ?? [],
    depth: agent.depth,
    createdAt: toISOString(agent.createdAt),
    updatedAt: toISOString(agent.updatedAt),
  };
}

export function serializeResource(resource: Resource): SerializedResource {
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    description: resource.description,
    content: resource.content,
    url: resource.url ? normalizeAssetUrl(resource.url) : null,
    ownerId: resource.ownerId,
    isPublic: resource.isPublic,
    visibility: resource.visibility ?? null,
    metadata: (toJsonSafe(resource.metadata ?? {}) as Record<string, unknown>),
    tags: (resource.tags ?? []) as string[],
    createdAt: toISOString(resource.createdAt),
    updatedAt: toISOString(resource.updatedAt),
  };
}
