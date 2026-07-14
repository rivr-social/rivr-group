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
  getEventsByProjectId,
  getJobsByProjectId,
  getTasksByJobIds,
} from "@/lib/queries/resources";
import {
  requireActorId,
  tryActorId,
  canViewAgent,
  canViewResource,
  filterViewableResources,
  filterPubliclyCrawlableResources,
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

/**
 * Returns event resources linked to a project via metadata-based association.
 *
 * Looks up rows from the resources table whose metadata links them to the
 * supplied projectId, then permission-filters according to the caller's
 * authentication state.
 *
 * @param projectId Project resource UUID.
 * @param limit Max events to return. Defaults to `100`.
 * @returns Serialized event resources visible to the caller.
 * @throws {Error} May throw on datastore failures.
 * @example
 * ```ts
 * const events = await fetchProjectEvents(projectId);
 * ```
 */
export async function fetchProjectEvents(
  projectId: string,
  limit = 100,
): Promise<SerializedResource[]> {
  if (!isUuid(projectId)) return [];
  const actorId = await tryActorId();
  const rows = await getEventsByProjectId(projectId, limit);

  const visible = actorId
    ? await filterViewableResources(actorId, rows as Resource[])
    : await filterPubliclyCrawlableResources(rows as Resource[]);

  return visible.map((row) => serializeResource(row));
}

/** One job on the group Jobs board, with its child tasks + computed points. */
export interface ProjectJobBoardJob {
  id: string;
  title: string;
  status: string;
  location: string;
  assignees: string[];
  maxAssignees: number;
  totalPoints: number;
  requiredBadges: string[];
  tasks: Array<{ id: string; name: string; description: string; points: number; completed: boolean }>;
}

/** Aggregated jobs/points/completion for a single project's Jobs-board card. */
export interface ProjectJobBoardData {
  jobs: ProjectJobBoardJob[];
  totalPoints: number;
  totalTasks: number;
  completedTasks: number;
  completion: number;
}

/**
 * Aggregates a project's jobs/points/completion by `metadata.projectId`
 * linkage, REGARDLESS of which subtree agent owns the job/task rows (parent
 * group, an owning circle/subgroup, or the project resource's owner) —
 * respecting per-row visibility. This replaces the group Jobs board's previous
 * `fetchResourcesByOwner(groupId)` scan, which silently dropped every
 * subgroup-owned job (a subgroup-owned project rendered "No jobs" / 0 points /
 * 0% even with dozens of linked jobs). Points/completion are computed from the
 * jobs' CHILD `task` resources (the current task model), not the legacy
 * embedded `metadata.tasks` array.
 *
 * @param projectId Project resource/agent UUID.
 */
export async function fetchProjectJobBoard(projectId: string): Promise<ProjectJobBoardData> {
  const empty: ProjectJobBoardData = { jobs: [], totalPoints: 0, totalTasks: 0, completedTasks: 0, completion: 0 };
  if (!isUuid(projectId)) return empty;

  const actorId = await tryActorId();
  const jobRows = await getJobsByProjectId(projectId);
  const visibleJobs = (actorId
    ? await filterViewableResources(actorId, jobRows as Resource[])
    : await filterPubliclyCrawlableResources(jobRows as Resource[])) as Resource[];

  const jobIds = visibleJobs.map((job) => job.id);
  const taskRows = await getTasksByJobIds(jobIds);

  // Child tasks grouped by parent job (owner-agnostic).
  const tasksByJob = new Map<string, ProjectJobBoardJob["tasks"]>();
  for (const task of taskRows) {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const jobId = typeof meta.jobId === "string" ? meta.jobId : null;
    if (!jobId) continue;
    const list = tasksByJob.get(jobId) ?? [];
    list.push({
      id: task.id,
      name: task.name,
      description: task.description ?? "",
      points: typeof meta.points === "number" ? meta.points : 0,
      completed: meta.completed === true || meta.status === "completed",
    });
    tasksByJob.set(jobId, list);
  }

  let totalTasks = 0;
  let completedTasks = 0;
  let totalPoints = 0;
  const jobs: ProjectJobBoardJob[] = visibleJobs.map((job) => {
    const meta = (job.metadata ?? {}) as Record<string, unknown>;
    const tasks = tasksByJob.get(job.id) ?? [];
    const taskPoints = tasks.reduce((sum, t) => sum + t.points, 0);
    const metaPoints =
      typeof meta.totalPoints === "number"
        ? meta.totalPoints
        : typeof meta.points === "number"
          ? meta.points
          : 0;
    const jobPoints = taskPoints > 0 ? taskPoints : metaPoints;
    totalTasks += tasks.length;
    completedTasks += tasks.filter((t) => t.completed).length;
    totalPoints += jobPoints;
    return {
      id: job.id,
      title: job.name,
      status: typeof meta.status === "string" ? meta.status : "open",
      location: typeof meta.location === "string" ? meta.location : "",
      assignees: Array.isArray(meta.assignees)
        ? meta.assignees.filter((a): a is string => typeof a === "string")
        : [],
      maxAssignees: typeof meta.maxAssignees === "number" ? meta.maxAssignees : 5,
      totalPoints: jobPoints,
      requiredBadges: Array.isArray(meta.requiredBadges)
        ? meta.requiredBadges.filter((b): b is string => typeof b === "string")
        : [],
      tasks,
    };
  });

  const completion = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  return { jobs, totalPoints, totalTasks, completedTasks, completion };
}
