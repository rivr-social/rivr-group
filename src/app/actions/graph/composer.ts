"use server";

import { db } from "@/db";
import { agents as agentsTable, resources as resourcesTable } from "@/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  tryActorId,
} from "./helpers";

/**
 * Fetches agents for the query composer dropdowns.
 * Returns a compact list of {id, name, type} for all visible agents.
 */
export async function fetchAgentsForComposer(
  limit = 200
): Promise<{ id: string; name: string; type: string }[]> {
  const actorId = await tryActorId();
  if (!actorId) return [];

  try {
    const rows = await db
      .select({ id: agentsTable.id, name: agentsTable.name, type: agentsTable.type })
      .from(agentsTable)
      .where(isNull(agentsTable.deletedAt))
      .orderBy(agentsTable.name)
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? "Unnamed",
      type: r.type,
    }));
  } catch (err) {
    console.error("[fetchAgentsForComposer] Failed:", err);
    return [];
  }
}

/**
 * Fetches resources for the query composer dropdowns.
 * Returns a compact list of {id, title, type} for all visible resources.
 */
export async function fetchResourcesForComposer(
  opts: { limit?: number; types?: string[]; ownerId?: string } = {}
): Promise<{ id: string; title: string; type: string; quantityAvailable?: number; quantityRemaining?: number }[]> {
  const { limit = 200, types, ownerId } = opts;
  const actorId = await tryActorId();
  if (!actorId) return [];

  try {
    const conditions = [isNull(resourcesTable.deletedAt)];

    if (types && types.length > 0) {
      conditions.push(inArray(resourcesTable.type, types as (typeof resourcesTable.type.enumValues)[number][]));
    }

    if (ownerId) {
      conditions.push(eq(resourcesTable.ownerId, ownerId));
    }

    const rows = await db
      .select({
        id: resourcesTable.id,
        name: resourcesTable.name,
        type: resourcesTable.type,
        metadata: resourcesTable.metadata,
      })
      .from(resourcesTable)
      .where(and(...conditions))
      .orderBy(resourcesTable.name)
      .limit(limit);

    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const quantityAvailable = typeof meta.quantityAvailable === "number" && Number.isFinite(meta.quantityAvailable)
        ? meta.quantityAvailable
        : undefined;
      const quantityRemaining = typeof meta.quantityRemaining === "number" && Number.isFinite(meta.quantityRemaining)
        ? meta.quantityRemaining
        : undefined;

      return {
        id: r.id,
        title: r.name ?? "Untitled",
        type: r.type,
        ...(quantityAvailable !== undefined ? { quantityAvailable } : {}),
        ...(quantityRemaining !== undefined ? { quantityRemaining } : {}),
      };
    });
  } catch (err) {
    console.error("[fetchResourcesForComposer] Failed:", err);
    return [];
  }
}
