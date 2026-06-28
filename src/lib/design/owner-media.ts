/**
 * Owner-media collection for the Polotno design editor's Photos panel.
 *
 * Purpose:
 * - The design editor is embedded in the context of an owning agent (a
 *   first-class user OR a group the editor is opened for). Its "Photos" side
 *   panel must surface THAT owner's own media — not a third-party stock service.
 * - This module is the single server-side source for "the images that belong to
 *   owner agent X", reusing the SAME pure gallery collector
 *   (`collectGalleryItems`) that powers profile/group galleries, so the editor's
 *   photo list is identical to what the owner already sees in their gallery.
 *
 * Identity: callers MUST pass an already-authorized `agentId` (resolved via
 * `resolveConnectionSubject` at the route boundary). This module performs no
 * auth — it only reads the resolved owner's media.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { agents, resources as resourcesTable } from "@/db/schema";
import {
  collectGalleryItems,
  type GallerySourceResource,
} from "@/lib/gallery";

/** Max resources scanned per owner when building the editor photo list. */
export const MAX_OWNER_MEDIA_RESOURCES = 500;

/** A single image offered to the editor's Photos panel. */
export interface OwnerMediaImage {
  /** Stable de-dup key (from the gallery item). */
  readonly key: string;
  /** Image URL to place on the canvas. */
  readonly src: string;
  /** Human-readable label / alt text. */
  readonly label: string;
}

/** Reads `metadata.profilePhotos` (string[]) off an agent metadata blob. */
function readProfilePhotos(metadata: Record<string, unknown> | null): string[] {
  const value = metadata?.profilePhotos;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Collects the owner agent's own images for the design editor's Photos panel.
 *
 * Sources (via the shared {@link collectGalleryItems}): the agent's uploaded
 * profile photos, the agent's avatar image, and every non-deleted Resource the
 * agent owns that carries media (typed `image` rows + any resource with
 * `metadata.images`/`imageUrl`/`coverImage`). Videos are excluded — the Photos
 * panel places still images onto the canvas.
 *
 * @param agentId An ALREADY-AUTHORIZED owner agent id.
 * @returns Newest-first, de-duplicated still images owned by the agent.
 */
export async function collectOwnerMediaImages(
  agentId: string,
): Promise<OwnerMediaImage[]> {
  const [owner] = await db
    .select({ image: agents.image, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!owner) return [];

  const metadata = (owner.metadata as Record<string, unknown> | null) ?? {};
  const profilePhotos = readProfilePhotos(metadata);
  if (typeof owner.image === "string" && owner.image.length > 0) {
    // The avatar is a legitimate "my photo" source; precedence matches the
    // gallery (profile photos first), so prepend it as a profile photo.
    profilePhotos.unshift(owner.image);
  }

  const rows = await db
    .select({
      id: resourcesTable.id,
      name: resourcesTable.name,
      type: resourcesTable.type,
      url: resourcesTable.url,
      contentType: resourcesTable.contentType,
      metadata: resourcesTable.metadata,
      createdAt: resourcesTable.createdAt,
    })
    .from(resourcesTable)
    .where(
      and(
        eq(resourcesTable.ownerId, agentId),
        sql`${resourcesTable.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(resourcesTable.createdAt))
    .limit(MAX_OWNER_MEDIA_RESOURCES);

  const resources: GallerySourceResource[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    contentType: row.contentType,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt,
  }));

  return collectGalleryItems({ profilePhotos, resources })
    .filter((item) => item.kind === "image")
    .map((item) => ({ key: item.key, src: item.src, label: item.label }));
}
