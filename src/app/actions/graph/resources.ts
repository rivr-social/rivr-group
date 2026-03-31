"use server";

import { db } from "@/db";
import type { Agent, Resource, ResourceType } from "@/db/schema";
import { wallets } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  toISOString,
  toJsonSafe,
  serializeAgent,
  serializeResource,
} from "@/lib/graph-serializers";
import type { SerializedAgent, SerializedResource, SerializedPostDetail } from "@/lib/graph-serializers";
import { q } from "@/lib/graph-query";
import { getAgent } from "@/lib/queries/agents";
import {
  getAllResources,
  getMarketplaceListings as queryMarketplaceListings,
  getResource,
} from "@/lib/queries/resources";
import {
  requireActorId,
  tryActorId,
  canViewAgent,
  canViewResource,
} from "./helpers";
import { isUuid, isAnonymousCrawlableVisibility } from "./types";

/**
 * Retrieves resources owned by an agent if the owner profile is viewable.
 *
 * @param ownerId Agent id that owns the resources.
 * @returns Serialized resources visible to the authenticated actor.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const resources = await fetchResourcesByOwner(ownerId);
 * ```
 */
export async function fetchResourcesByOwner(ownerId: string): Promise<SerializedResource[]> {
  return q("required", { table: "resources", fn: "getResourcesByOwner", ownerId }, { requireViewable: ownerId });
}

/**
 * Returns public resources; authenticated callers still run through policy checks.
 *
 * @param limit Max resources returned.
 * @returns Serialized public resources allowed in the caller context.
 * @throws {Error} May throw on query/permission evaluation failures.
 * @example
 * ```ts
 * const publicResources = await fetchPublicResources(100);
 * ```
 */
export async function fetchPublicResources(limit = 50): Promise<SerializedResource[]> {
  return q("optional", { table: "resources", fn: "getPublicResources", limit });
}

/**
 * Retrieves resources with optional filters and appends serialized owners when present.
 *
 * @param options Optional type/pagination options.
 * @returns Visible serialized resources with optional embedded owner.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated user is present.
 * @example
 * ```ts
 * const resources = await fetchAllResources({ type: "post", limit: 30 });
 * ```
 */
export async function fetchAllResources(options?: {
  type?: ResourceType;
  limit?: number;
  offset?: number;
}) {
  const actorId = await requireActorId();
  const resources = await getAllResources(options);

  // Resource rows may contain joined owner data; permission checks are still row-by-row.
  const permissions = await Promise.all(
    resources.map((resource) => canViewResource(actorId, (resource as Resource).id))
  );

  return resources
    .filter((_, i) => permissions[i])
    .map((resource) => {
      const typed = resource as Resource & { owner?: Agent | null };
      return {
        ...serializeResource(typed),
        owner: typed.owner ? serializeAgent(typed.owner) : null,
      };
    });
}

/**
 * Returns marketplace listings, optionally permission-filtered for authenticated callers.
 *
 * @param limit Max listing rows requested.
 * @returns Serialized listing resources with owner display fields.
 * @throws {Error} May throw on underlying query or permission-check failures.
 * @example
 * ```ts
 * const listings = await fetchMarketplaceListings(24);
 * ```
 */
export async function fetchMarketplaceListings(limit = 50) {
  const actorId = await tryActorId();
  const listings = await queryMarketplaceListings(limit);

  if (actorId) {
    // Enforce resource-level authorization even for pre-filtered marketplace query rows.
    const permissions = await Promise.all(
      listings.map((item) => canViewResource(actorId, (item as Resource).id))
    );
    return listings
      .filter((_, i) => permissions[i])
      .map((item) => ({
        ...serializeResource(item as unknown as Resource),
        ownerName: (item as { owner_name?: string }).owner_name ?? "",
        ownerImage: (item as { owner_image?: string }).owner_image ?? "",
      }));
  }

  return listings.map((item) => ({
    ...serializeResource(item as unknown as Resource),
    ownerName: (item as { owner_name?: string }).owner_name ?? "",
    ownerImage: (item as { owner_image?: string }).owner_image ?? "",
  }));
}

/**
 * Fetches one marketplace listing by id if it is both visible and marketplace-typed.
 *
 * Business rule:
 * - Any resource with a non-empty `listingType` metadata value is considered a marketplace listing.
 *
 * @param id Resource id for the listing.
 * @returns Serialized listing resource, or `null` when not visible/not a listing.
 * @throws {Error} May throw on datastore failures.
 * @example
 * ```ts
 * const listing = await fetchMarketplaceListingById(listingId);
 * ```
 */
export async function fetchMarketplaceListingById(id: string): Promise<{
  resource: SerializedResource;
  owner: SerializedAgent | null;
} | null> {
  if (!isUuid(id)) return null;
  const actorId = await tryActorId();
  const resource = await getResource(id);
  if (!resource) return null;

  if (actorId) {
    if (!(await canViewResource(actorId, resource.id))) return null;
  } else if (!isAnonymousCrawlableVisibility(resource)) {
    return null;
  }

  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  const listingType = String(metadata.listingType ?? "").toLowerCase();
  if (!listingType) return null;

  const owner = await getAgent(resource.ownerId);
  let serializedOwner: SerializedAgent | null = null;
  let cardCheckoutAvailable = false;
  let cardCheckoutUnavailableReason = "Seller has not set up card payments yet.";
  if (owner) {
    if (actorId && !(await canViewAgent(actorId, owner.id))) {
      serializedOwner = null;
    } else if (!actorId && !isAnonymousCrawlableVisibility(owner)) {
      serializedOwner = null;
    } else {
      serializedOwner = serializeAgent(owner);
    }

    const settlementWalletType =
      ["organization", "ring", "family", "guild", "community"].includes(
        String(owner.type ?? "").toLowerCase(),
      )
        ? "group"
        : "personal";

    const [sellerWallet] = await db
      .select({ metadata: wallets.metadata })
      .from(wallets)
      .where(
        and(
          eq(wallets.ownerId, owner.id),
          eq(wallets.type, settlementWalletType),
        ),
      )
      .limit(1);

    const walletMeta = (sellerWallet?.metadata ?? {}) as Record<string, unknown>;
    const hasConnectAccount =
      typeof walletMeta.stripeConnectAccountId === "string" &&
      walletMeta.stripeConnectAccountId.length > 0;
    const chargesEnabled = walletMeta.connectChargesEnabled === true;

    cardCheckoutAvailable = hasConnectAccount && chargesEnabled;
    if (!hasConnectAccount) {
      cardCheckoutUnavailableReason = "Seller has not set up card payments yet.";
    } else if (!chargesEnabled) {
      cardCheckoutUnavailableReason = "Seller payment account is not fully enabled yet.";
    }
  }

  const serializedResource = serializeResource(resource);
  serializedResource.metadata = {
    ...serializedResource.metadata,
    cardCheckoutAvailable,
    cardCheckoutUnavailableReason,
  };

  return {
    resource: serializedResource,
    owner: serializedOwner,
  };
}

/**
 * Fetches a post-like resource and its author if visible to the caller.
 *
 * Security behavior:
 * - If the post is viewable but the author is not, author details are redacted (`author: null`).
 *
 * @param postId Resource id to resolve.
 * @returns Post detail with serialized resource and optional serialized author.
 * @throws {Error} May throw on datastore/permission-check failures.
 * @example
 * ```ts
 * const detail = await fetchPostDetail(postId);
 * ```
 */
export async function fetchPostDetail(postId: string): Promise<SerializedPostDetail | null> {
  if (!isUuid(postId)) return null;
  const actorId = await tryActorId();
  const resource = await getResource(postId);
  if (!resource) return null;

  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  const isPost =
    resource.type === "post" ||
    resource.type === "note" ||
    String(metadata.entityType ?? "").toLowerCase() === "post";
  if (!isPost) return null;

  if (actorId) {
    if (!(await canViewResource(actorId, resource.id))) return null;
  } else if (!isAnonymousCrawlableVisibility(resource)) {
    return null;
  }

  const author = await getAgent(resource.ownerId);
  if (author && actorId) {
    if (!(await canViewAgent(actorId, author.id))) {
      // Prevent leaking identity metadata when post visibility exceeds author visibility.
      return {
        resource: serializeResource(resource),
        author: null,
      };
    }
  } else if (author && !isAnonymousCrawlableVisibility(author)) {
    return {
      resource: serializeResource(resource),
      author: null,
    };
  }

  return {
    resource: serializeResource(resource),
    author: author ? serializeAgent(author) : null,
  };
}

/**
 * Resolves an event from either an agent record or an event-like resource record.
 *
 * Business rules:
 * - Resource fallback is accepted when type/entity metadata marks it as an event.
 * - Anonymous callers can only view public resource-backed events.
 *
 * @param eventId Event id.
 * @returns Serialized event representation, or `null` when not visible/not an event.
 * @throws {Error} May throw on datastore/authorization failures.
 * @example
 * ```ts
 * const event = await fetchEventDetail(eventId);
 * ```
 */
export async function fetchEventDetail(eventId: string): Promise<SerializedAgent | null> {
  if (!isUuid(eventId)) return null;
  const actorId = await tryActorId();

  // Events are resources, not agents. Look up directly from the resources table.
  const eventResource = await getResource(eventId);
  if (!eventResource) return null;

  const resourceMeta = (toJsonSafe(eventResource.metadata ?? {}) as Record<string, unknown>);
  const isEventResource =
    eventResource.type === "event" ||
    String(resourceMeta.entityType ?? "").toLowerCase() === "event" ||
    String(resourceMeta.resourceKind ?? "").toLowerCase() === "event";

  if (!isEventResource) return null;

  if (!actorId) {
    if (!isAnonymousCrawlableVisibility(eventResource)) return null;
  } else if (!(await canViewResource(actorId, eventResource.id))) {
    return null;
  }

  const owner = (eventResource as Resource & { owner?: Agent | null }).owner ?? null;
  const chapterTags = Array.isArray(resourceMeta.chapterTags)
    ? (resourceMeta.chapterTags as string[])
    : [];
  const ownerPathIds = Array.isArray(owner?.pathIds) ? owner.pathIds : [];
  const ownerChapterTags =
    owner && owner.metadata && Array.isArray((owner.metadata as Record<string, unknown>).chapterTags)
      ? ((owner.metadata as Record<string, unknown>).chapterTags as string[])
      : [];
  // Scope tags combine resource and owner context so downstream scoped views stay consistent.
  const scopeTags = Array.from(new Set([...chapterTags, ...ownerChapterTags, ...ownerPathIds]));

  return {
    id: eventResource.id,
    name: eventResource.name,
    type: "event",
    description: eventResource.description,
    email: null,
    image: null,
    metadata: {
      ...resourceMeta,
      startDate: (resourceMeta.date as string) ?? toISOString(eventResource.createdAt),
      endDate: (resourceMeta.date as string) ?? toISOString(eventResource.createdAt),
      creatorId: eventResource.ownerId,
      tags: eventResource.tags ?? [],
      chapterTags: scopeTags,
    },
    parentId: (resourceMeta.groupId as string) ?? null,
    pathIds: scopeTags,
    depth: 0,
    createdAt: toISOString(eventResource.createdAt),
    updatedAt: toISOString(eventResource.updatedAt),
  };
}
