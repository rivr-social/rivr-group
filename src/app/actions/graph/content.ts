"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import type { Resource } from "@/db/schema";
import { agents as agentsTable, resources as resourcesTable } from "@/db/schema";
import { sql, and, eq, desc } from "drizzle-orm";
import {
  toISOString,
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import { q } from "@/lib/graph-query";
import {
  getPlacesByPlaceType,
} from "@/lib/queries/agents";
import {
  getResourcesForGroup,
} from "@/lib/queries/resources";
import {
  requireActorId,
} from "./helpers";

/**
 * Returns badge resources earned by a specific user.
 * Checks the ledger for 'earn'/'assign' verbs targeting the user with badge resources.
 */
export async function fetchUserBadges(userId: string): Promise<SerializedResource[]> {
  const result = await db.execute(sql`
    SELECT r.*
    FROM resources r
    JOIN ledger l ON l.object_id = r.id::text
    WHERE r.type = 'badge'
      AND r.deleted_at IS NULL
      AND l.subject_id = ${userId}
      AND l.verb IN ('earn', 'assign')
      AND l.is_active = true
    ORDER BY l.timestamp DESC
  `);
  const rows = result as Record<string, unknown>[];
  return rows.map((row) => serializeResource({
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    description: (row.description ?? null) as string | null,
    content: (row.content ?? null) as string | null,
    url: (row.url ?? null) as string | null,
    ownerId: row.owner_id as string,
    isPublic: (row.is_public ?? false) as boolean,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    tags: (row.tags ?? null) as string[] | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    deletedAt: null,
    contentType: null,
    storageKey: null,
    storageProvider: null,
    fileSize: null,
    visibility: "members",
    embedding: null,
    location: null,
  } as Resource));
}

/**
 * Returns voucher resources for a group/ring.
 */
export async function fetchVouchersForGroup(groupId: string): Promise<SerializedResource[]> {
  const resources = await getResourcesForGroup(groupId, 200);
  const vouchers = resources.filter((r) => r.type === "voucher");
  return vouchers.map(serializeResource);
}

/**
 * Returns ledger entries representing claims against a specific voucher resource.
 */
export async function fetchVoucherClaims(voucherId: string) {
  const result = await db.execute(sql`
    SELECT l.*, a.name as claimer_name, a.image as claimer_image
    FROM ledger l
    JOIN agents a ON l.subject_id = a.id::text
    WHERE l.object_id = ${voucherId}
      AND l.verb IN ('redeem', 'claim')
      AND l.is_active = true
    ORDER BY l.timestamp DESC
  `);
  return (result as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    claimerId: row.subject_id as string,
    claimerName: row.claimer_name as string,
    claimerImage: (row.claimer_image ?? null) as string | null,
    timestamp: (row.timestamp as Date).toISOString(),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Returns ids of marketplace listings saved by the current actor.
 *
 * Security and business rules:
 * - Uses parameterized SQL interpolation for `actorId` to avoid injection.
 * - Only active, non-deleted `share` interactions with `interactionType = save` are included.
 *
 * @param none This action does not accept arguments.
 * @returns Unique listing ids ordered by most recent save first (deduped preserving first occurrence).
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const savedListingIds = await fetchMySavedListingIds();
 * ```
 */
export async function fetchMySavedListingIds(): Promise<string[]> {
  const actorId = await requireActorId();

  const rows = await db.execute(sql`
    SELECT
      COALESCE(metadata->>'targetId', object_id::text) AS listing_id
    FROM ledger
    WHERE subject_id = ${actorId}::uuid
      AND verb = 'share'
      AND is_active = true
      AND metadata->>'interactionType' = 'save'
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  const ids = (rows as Array<Record<string, unknown>>)
    .map((row) => row.listing_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return Array.from(new Set(ids));
}

/**
 * Fetches receipt resources owned by the current authenticated user,
 * joined with their original listing data.
 */
export async function fetchMyReceipts(): Promise<{
  receipts: Array<{
    id: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    listing: { id: string; name: string; description: string | null; metadata: Record<string, unknown> } | null;
    seller: { id: string; name: string; username: string | null; image: string | null } | null;
  }>;
}> {
  const session = await auth();
  if (!session?.user?.id) return { receipts: [] };

  const receiptRows = await db
    .select({
      id: resourcesTable.id,
      name: resourcesTable.name,
      metadata: resourcesTable.metadata,
      createdAt: resourcesTable.createdAt,
    })
    .from(resourcesTable)
    .where(
      and(
        eq(resourcesTable.ownerId, session.user.id),
        eq(resourcesTable.type, 'receipt')
      )
    )
    .orderBy(desc(resourcesTable.createdAt));

  const receipts = await Promise.all(
    receiptRows.map(async (r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const listingId = meta.originalListingId as string | undefined;
      const sellerAgentId = meta.sellerAgentId as string | undefined;

      let listing: { id: string; name: string; description: string | null; metadata: Record<string, unknown> } | null = null;
      let seller: { id: string; name: string; username: string | null; image: string | null } | null = null;

      if (listingId) {
        const [row] = await db
          .select({ id: resourcesTable.id, name: resourcesTable.name, description: resourcesTable.description, metadata: resourcesTable.metadata })
          .from(resourcesTable)
          .where(eq(resourcesTable.id, listingId))
          .limit(1);
        if (row) listing = { ...row, metadata: (row.metadata ?? {}) as Record<string, unknown> };
      }

      if (sellerAgentId) {
        const [row] = await db
          .select({ id: agentsTable.id, name: agentsTable.name, metadata: agentsTable.metadata, image: agentsTable.image })
          .from(agentsTable)
          .where(eq(agentsTable.id, sellerAgentId))
          .limit(1);
        if (row) {
          const agentMeta = (row.metadata ?? {}) as Record<string, unknown>;
          seller = {
            id: row.id,
            name: row.name,
            username: (agentMeta.username as string) || null,
            image: row.image,
          };
        }
      }

      return {
        id: r.id,
        metadata: meta,
        createdAt: r.createdAt?.toISOString?.() ?? new Date().toISOString(),
        listing,
        seller,
      };
    })
  );

  return { receipts };
}

/**
 * Lists event agents viewable by the current authenticated actor.
 *
 * @param limit Max rows requested from the backing query.
 * @returns Serialized event agents permitted for the actor.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const events = await fetchEvents(30);
 * ```
 */
export async function fetchEvents(limit = 50): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentsByType", type: "event", limit });
}

/**
 * Lists place agents from supported place subtypes.
 *
 * @param limit Max rows requested per subtype query.
 * @returns Serialized place agents viewable by the actor.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const places = await fetchPlaces(20);
 * ```
 */
export async function fetchPlaces(limit = 50): Promise<SerializedAgent[]> {
  const [chapters, basins, councils] = await Promise.all([
    q<SerializedAgent[]>("required", { table: "agents", fn: "getPlacesByPlaceType", placeType: "chapter", limit }),
    q<SerializedAgent[]>("required", { table: "agents", fn: "getPlacesByPlaceType", placeType: "basin", limit }),
    q<SerializedAgent[]>("required", { table: "agents", fn: "getPlacesByPlaceType", placeType: "council", limit }),
  ]);
  return [...chapters, ...basins, ...councils];
}

/**
 * Lists project agents viewable by the current authenticated actor.
 *
 * @param limit Max rows requested from the backing query.
 * @returns Serialized project agents.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const projects = await fetchProjects();
 * ```
 */
export async function fetchProjects(limit = 50): Promise<SerializedAgent[]> {
  return q("required", { table: "agents", fn: "getAgentsByType", type: "project", limit });
}
