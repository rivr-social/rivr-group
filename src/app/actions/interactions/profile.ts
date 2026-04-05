"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import type { NewLedgerEntry, NewResource } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { updateProfileAction } from "@/app/actions/settings";
import { emitDomainEvent, EVENT_TYPES, federatedWrite } from "@/lib/federation";
import {
  getCurrentUserId,
  toggleLedgerInteraction,
} from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/**
 * Updates profile core fields plus additional metadata values.
 *
 * @param {{
 *   name: string;
 *   bio: string;
 *   skills: string[];
 *   location?: string;
 * }} payload - Profile payload from settings/profile UI.
 * @returns {Promise<ActionResult>} Update status and user-facing message.
 * @throws {Error} Unexpected DB/action failures may propagate.
 * @example
 * ```ts
 * await updateMyProfile({ name: "User", bio: "Builder", skills: ["Design"], location: "SF" });
 * ```
 */
export async function updateMyProfile(payload: {
  name: string;
  bio: string;
  skills: string[];
  location?: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to update your profile." };

  const facadeResult = await federatedWrite(
    {
      type: 'updateMyProfile',
      actorId: userId,
      targetAgentId: userId,
      payload,
    },
    async () => {
      const [existing] = await db
        .select({ metadata: agents.metadata, email: agents.email })
        .from(agents)
        .where(eq(agents.id, userId))
        .limit(1);

      const existingMeta = ((existing?.metadata ?? {}) as Record<string, unknown>);
      const profileResult = await updateProfileAction({
        name: payload.name,
        username: String(existingMeta.username ?? "").trim() || `user-${userId.slice(0, 8)}`,
        email: existing?.email ?? "",
        bio: payload.bio,
        phone: String(existingMeta.phone ?? ""),
      });
      if (!profileResult.success) {
        // Preserve upstream validation/error messages from the profile action contract.
        throw new Error(profileResult.error ?? "Unable to update profile.");
      }

      // Re-read metadata AFTER updateProfileAction to avoid overwriting changes it made.
      const [fresh] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, userId))
        .limit(1);
      const freshMeta = ((fresh?.metadata ?? {}) as Record<string, unknown>);
      const freshMergedMetadata = {
        ...freshMeta,
        skills: payload.skills
          .map((skill) => skill.trim())
          .filter((skill) => skill.length > 0),
        location: (payload.location ?? "").trim(),
        updatedVia: "profile-page",
      };

      await db.execute(sql`
        UPDATE agents
        SET metadata = ${JSON.stringify(freshMergedMetadata)}::jsonb
        WHERE id = ${userId}
      `);

      return { success: true, message: "Profile updated." } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Unable to update profile." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.AGENT_UPDATED,
    entityType: 'agent',
    entityId: userId,
    actorId: userId,
    payload: { action: 'update_profile' },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Profile updated." };
}

/**
 * Toggles saved-state on a marketplace listing.
 *
 * @param {string} listingId - Listing identifier.
 * @returns {Promise<ActionResult>} Interaction state result.
 * @throws {Error} Unexpected database errors may propagate.
 * @example
 * ```ts
 * await toggleSaveListing("listing-id");
 * ```
 */
export async function toggleSaveListing(listingId: string): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to save listings." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const facadeResult = await federatedWrite(
    {
      type: 'toggleSaveListing',
      actorId: userId,
      targetAgentId: userId,
      payload: { listingId },
    },
    async () => {
      return toggleLedgerInteraction(userId, "share", "save", listingId, "listing");
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to save listing." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.AGENT_UPDATED,
    entityType: 'agent',
    entityId: userId,
    actorId: userId,
    payload: { action: 'toggle_save', listingId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Listing save toggled." };
}

/**
 * Creates a gallery resource owned by the current user and optionally scoped to a group.
 *
 * The gallery is stored as a `post` resource with `postType: "gallery"` so it
 * surfaces through the existing resource pipeline. The group ID is included in
 * tags for feed filtering.
 *
 * @param {{
 *   title: string;
 *   groupId?: string;
 * }} input - Gallery title and optional group scoping.
 * @returns {Promise<ActionResult>} Result with the new resource ID on success.
 * @throws {Error} Unexpected DB failures may propagate.
 * @example
 * ```ts
 * const result = await createGalleryAction({ title: "Summer Event Photos", groupId: "group-uuid" });
 * ```
 */
export async function createGalleryAction(input: {
  title: string;
  groupId?: string;
}): Promise<ActionResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to create a gallery." };

  if (!input.title?.trim()) return { success: false, message: "Gallery title is required." };

  const check = await rateLimit(`social:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const facadeResult = await federatedWrite(
    {
      type: 'createGalleryAction',
      actorId: userId,
      targetAgentId: userId,
      payload: input,
    },
    async () => {
      const tags = input.groupId ? [input.groupId] : [];

      const [created] = await db
        .insert(resources)
        .values({
          name: input.title.trim(),
          type: "post",
          description: null,
          content: null,
          ownerId: userId,
          visibility: "public",
          tags,
          metadata: {
            entityType: "post",
            postType: "gallery",
            groupId: input.groupId ?? null,
            images: [],
          },
        } as NewResource)
        .returning({ id: resources.id });

      await db.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: created.id,
        objectType: "resource",
        resourceId: created.id,
        metadata: {
          resourceType: "post",
          postType: "gallery",
          groupId: input.groupId ?? null,
          source: "press-tab",
        },
      } as NewLedgerEntry);

      revalidatePath("/");
      if (input.groupId) {
        revalidatePath(`/groups/${input.groupId}`);
      }

      return { success: true, message: "Gallery created successfully.", resourceId: created.id } as ActionResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to create gallery." };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.AGENT_UPDATED,
    entityType: 'resource',
    entityId: facadeResult.data?.resourceId ?? '',
    actorId: userId,
    payload: { action: 'create_gallery', groupId: input.groupId },
  }).catch(() => {});

  return facadeResult.data ?? { success: true, message: "Gallery created successfully." };
}
