"use server";

import { db } from "@/db";
import { agents as agentsTable, resources as resourcesTable, ledger as ledgerTable } from "@/db/schema";
import { sql, and, eq, desc, inArray, gte, lte } from "drizzle-orm";
import { generateEmbedding, EMBEDDING_DIMENSIONS } from "@/lib/ai";
import { q } from "@/lib/graph-query";
import type { SerializedAgent } from "@/lib/graph-serializers";
import {
  tryActorId,
} from "./helpers";

import type { SemanticSearchResult, LedgerQueryFilter, LedgerQueryResult } from "./types";

const MAX_SEMANTIC_RESULTS = 20;
const MAX_QUERY_LENGTH = 500;

/**
 * Performs semantic search across agents and resources using pgvector cosine distance.
 *
 * Privacy rules:
 * - Agents: only returns entities with visibility `public` or `locale`, or owned by the caller
 *   (i.e., the caller's own agent record).
 * - Resources: only returns entities with visibility `public` or `locale`, or where the caller
 *   is the owner. `private`, `hidden`, and `members`-only resources are excluded from
 *   the global search space unless the caller owns them.
 * - Soft-deleted entities are always excluded.
 *
 * @param query - Natural language search query (max 500 chars).
 * @param limit - Maximum number of results (default 20).
 * @returns Combined agent + resource results sorted by cosine similarity (ascending distance).
 */
export async function semanticSearch(
  query: string,
  limit: number = MAX_SEMANTIC_RESULTS
): Promise<SemanticSearchResult[]> {
  if (!query || query.trim().length === 0) return [];

  const trimmedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  const effectiveLimit = Math.min(Math.max(1, limit), MAX_SEMANTIC_RESULTS);

  const actorId = await tryActorId();

  let queryVector: number[];
  try {
    queryVector = await generateEmbedding(trimmedQuery);
  } catch {
    // If the embedding model is unavailable, fall back gracefully.
    return [];
  }

  const vectorLiteral = `[${queryVector.join(",")}]`;

  // Build actor ownership conditions: include own entities regardless of visibility.
  const agentOwnerClause = actorId
    ? sql`OR a.id = ${actorId}`
    : sql``;

  const resourceOwnerClause = actorId
    ? sql`OR r.owner_id = ${actorId}`
    : sql``;

  // Run both queries in parallel for performance.
  const [agentRows, resourceRows] = await Promise.all([
    db.execute(sql`
      SELECT
        a.id,
        a.name,
        a.description,
        a.type,
        a.image,
        a.metadata,
        a.embedding <=> ${vectorLiteral}::vector AS distance
      FROM agents a
      WHERE a.embedding IS NOT NULL
        AND a.deleted_at IS NULL
        AND (a.visibility IN ('public', 'locale') ${agentOwnerClause})
      ORDER BY distance ASC
      LIMIT ${effectiveLimit}
    `),
    db.execute(sql`
      SELECT
        r.id,
        r.name,
        r.description,
        r.type,
        r.metadata,
        r.embedding <=> ${vectorLiteral}::vector AS distance
      FROM resources r
      WHERE r.embedding IS NOT NULL
        AND r.deleted_at IS NULL
        AND (r.visibility IN ('public', 'locale') ${resourceOwnerClause})
      ORDER BY distance ASC
      LIMIT ${effectiveLimit}
    `),
  ]);

  const results: SemanticSearchResult[] = [];

  for (const row of agentRows as Record<string, unknown>[]) {
    results.push({
      id: row.id as string,
      name: row.name as string,
      description: (row.description ?? null) as string | null,
      type: row.type as string,
      table: "agents",
      image: (row.image ?? null) as string | null,
      distance: Number(row.distance),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    });
  }

  for (const row of resourceRows as Record<string, unknown>[]) {
    results.push({
      id: row.id as string,
      name: row.name as string,
      description: (row.description ?? null) as string | null,
      type: row.type as string,
      table: "resources",
      image: null,
      distance: Number(row.distance),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    });
  }

  // Merge and sort combined results by distance (lower = more similar).
  results.sort((a, b) => a.distance - b.distance);

  return results.slice(0, effectiveLimit);
}

/**
 * Searches agents inside a specific scope after validating scope visibility.
 *
 * @param scopeId Scope agent id.
 * @param query Search text.
 * @param limit Max results requested.
 * @returns Serialized in-scope agents visible to the caller.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const matches = await searchInScope(scopeId, "water", 20);
 * ```
 */
export async function searchInScope(
  scopeId: string,
  query: string,
  limit = 20
): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "searchAgentsInScope", scopeId, query, limit }, { requireViewable: scopeId });
}


/**
 * Queries ledger entries with optional filters for the visual query composer.
 * Returns entries with resolved subject/object names for graph display.
 */
export async function queryLedgerEntries(
  filter: LedgerQueryFilter,
  limit = 100
): Promise<LedgerQueryResult[]> {
  const actorId = await tryActorId();
  if (!actorId) return [];

  try {
    const conditions = [eq(ledgerTable.isActive, true)];

    if (filter.subjectId) {
      conditions.push(eq(ledgerTable.subjectId, filter.subjectId));
    }
    if (filter.verb) {
      conditions.push(eq(ledgerTable.verb, filter.verb as never));
    }
    if (filter.objectId) {
      conditions.push(eq(ledgerTable.objectId, filter.objectId));
    }
    if (filter.startDate) {
      conditions.push(gte(ledgerTable.timestamp, new Date(filter.startDate)));
    }
    if (filter.endDate) {
      conditions.push(lte(ledgerTable.timestamp, new Date(filter.endDate)));
    }

    const entries = await db
      .select()
      .from(ledgerTable)
      .where(and(...conditions))
      .orderBy(desc(ledgerTable.timestamp))
      .limit(limit);

    if (entries.length === 0) return [];

    // Collect all unique agent IDs to resolve names in a single query
    const agentIds = new Set<string>();
    for (const entry of entries) {
      agentIds.add(entry.subjectId);
      if (entry.objectId) agentIds.add(entry.objectId);
    }

    const agentRows = agentIds.size > 0
      ? await db
          .select({ id: agentsTable.id, name: agentsTable.name, type: agentsTable.type })
          .from(agentsTable)
          .where(inArray(agentsTable.id, Array.from(agentIds)))
      : [];

    const agentMap = new Map(agentRows.map((a) => [a.id, a]));

    // Collect resource IDs for name resolution
    const resourceIds = new Set<string>();
    for (const entry of entries) {
      if (entry.resourceId) resourceIds.add(entry.resourceId);
    }

    const resourceRows = resourceIds.size > 0
      ? await db
          .select({ id: resourcesTable.id, name: resourcesTable.name, type: resourcesTable.type })
          .from(resourcesTable)
          .where(inArray(resourcesTable.id, Array.from(resourceIds)))
      : [];

    const resourceMap = new Map(resourceRows.map((r) => [r.id, r]));

    return entries.map((entry) => {
      const subject = agentMap.get(entry.subjectId);
      const object = entry.objectId ? agentMap.get(entry.objectId) : null;
      const resource = entry.resourceId ? resourceMap.get(entry.resourceId) : null;

      return {
        id: entry.id,
        verb: entry.verb,
        subjectId: entry.subjectId,
        subjectName: subject?.name ?? "Unknown",
        subjectType: subject?.type ?? "person",
        objectId: entry.objectId,
        objectName: object?.name ?? resource?.name ?? null,
        objectType: entry.objectType ?? object?.type ?? resource?.type ?? null,
        resourceId: entry.resourceId,
        timestamp: entry.timestamp?.toISOString() ?? new Date().toISOString(),
      };
    });
  } catch (err) {
    console.error("[queryLedgerEntries] Failed:", err);
    return [];
  }
}
