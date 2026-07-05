"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { canPostToGroup, hasGroupWriteAccess, createPostResource } from "@/app/actions/create-resources";
import { PostType } from "@/lib/types";
import {
  MAX_STOCK_NEED_NAME_LENGTH,
  MAX_STOCK_NEED_NOTE_LENGTH,
  STOCK_NEEDS_METADATA_KEY,
  buildNeedRequestText,
  extractStockNeeds,
  normalizeStockNeedQuantity,
  type StockNeed,
  type StockParentType,
} from "@/lib/stock";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Uniform result shape for every stock-needs mutation. */
export interface StockNeedsResult {
  success: boolean;
  error?: string;
  needs?: StockNeed[];
  /** On a successful "post as request", the id of the created post resource. */
  postResourceId?: string;
}

/** Editable fields accepted when adding or updating a need. */
export interface StockNeedInput {
  name: string;
  quantity?: number;
  note?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolved, authorized parent for a stock-needs mutation. Carries the current
 * metadata plus the routing needed to persist and to create a request post.
 */
interface ResolvedStockParent {
  parentType: StockParentType;
  parentId: string;
  metadata: Record<string, unknown>;
  /** Group to post a request INTO (`createPostResource.groupId`), if any. */
  postGroupId: string | null;
  /** Owner agent to post a request AS (`createPostResource.ownerId`), if any. */
  postOwnerId: string | null;
}

/**
 * Load the parent object, enforce the authorization gate for the given type,
 * and return the routing needed to persist Needs and post requests.
 *
 * Authorization:
 *  - org: {@link isGroupAdmin} OR {@link canPostToGroup}.
 *  - project/job: resource owner OR {@link hasGroupWriteAccess} on the owning group.
 *
 * @returns the resolved parent, or a string error code on failure.
 */
async function resolveAuthorizedStockParent(
  parentType: StockParentType,
  parentId: string,
  userId: string,
): Promise<ResolvedStockParent | string> {
  if (!UUID_RE.test(parentId)) return "Invalid parent id.";

  if (parentType === "org") {
    const [org] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, parentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!org) return "Organization not found.";

    const authorized =
      (await isGroupAdmin(userId, parentId)) || (await canPostToGroup(userId, parentId, "create"));
    if (!authorized) return "You do not have permission to edit this org's stock needs.";

    return {
      parentType,
      parentId,
      metadata: asRecord(org.metadata),
      postGroupId: parentId,
      postOwnerId: null,
    };
  }

  // project | job — both persist Needs on the resources row.
  const [row] = await db
    .select({ ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, parentId), isNull(resources.deletedAt)))
    .limit(1);
  if (!row) return parentType === "project" ? "Project not found." : "Job not found.";

  const metadata = asRecord(row.metadata);
  const owningGroupId = typeof metadata.groupId === "string" ? metadata.groupId : null;
  const isOwner =
    row.ownerId === userId ||
    metadata.creatorId === userId ||
    metadata.ownerId === userId;
  const authorized =
    isOwner || (owningGroupId ? await hasGroupWriteAccess(userId, owningGroupId) : false);
  if (!authorized) {
    return parentType === "project"
      ? "You do not have permission to edit this project's stock needs."
      : "You do not have permission to edit this job's stock needs.";
  }

  return {
    parentType,
    parentId,
    metadata,
    postGroupId: owningGroupId,
    postOwnerId: owningGroupId ? null : row.ownerId,
  };
}

/** Persist a new Needs list into the parent's metadata and revalidate its page. */
async function persistStockNeeds(parent: ResolvedStockParent, needs: StockNeed[]): Promise<void> {
  const nextMetadata = { ...parent.metadata, [STOCK_NEEDS_METADATA_KEY]: needs };

  if (parent.parentType === "org") {
    await db
      .update(agents)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(agents.id, parent.parentId));
    revalidatePath(`/groups/${parent.parentId}`);
    revalidatePath(`/rings/${parent.parentId}`);
    revalidatePath(`/families/${parent.parentId}`);
    return;
  }

  await db
    .update(resources)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(resources.id, parent.parentId));
  revalidatePath(
    parent.parentType === "project" ? `/projects/${parent.parentId}` : `/jobs/${parent.parentId}`,
  );
}

/** Resolve the current session user id, or `null` when unauthenticated. */
async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/**
 * Fetch the current Needs list for a parent object (read helper for hydration).
 * Returns an empty list for unauthenticated callers or unknown parents.
 */
export async function getStockNeedsAction(
  parentType: StockParentType,
  parentId: string,
): Promise<StockNeed[]> {
  if (!UUID_RE.test(parentId)) return [];

  if (parentType === "org") {
    const [org] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, parentId), isNull(agents.deletedAt)))
      .limit(1);
    return org ? extractStockNeeds(asRecord(org.metadata)) : [];
  }

  const [row] = await db
    .select({ metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, parentId), isNull(resources.deletedAt)))
    .limit(1);
  return row ? extractStockNeeds(asRecord(row.metadata)) : [];
}

/** Append a new need to the parent's shopping list. */
export async function addStockNeedAction(
  parentType: StockParentType,
  parentId: string,
  input: StockNeedInput,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const name = input.name?.trim();
  if (!name) return { success: false, error: "A need name is required." };
  if (name.length > MAX_STOCK_NEED_NAME_LENGTH) {
    return { success: false, error: `Name exceeds ${MAX_STOCK_NEED_NAME_LENGTH} characters.` };
  }
  const note = (input.note ?? "").trim();
  if (note.length > MAX_STOCK_NEED_NOTE_LENGTH) {
    return { success: false, error: `Note exceeds ${MAX_STOCK_NEED_NOTE_LENGTH} characters.` };
  }

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = extractStockNeeds(parent.metadata);
  const newNeed: StockNeed = {
    id: randomUUID(),
    name,
    quantity: normalizeStockNeedQuantity(input.quantity),
    note,
    fulfilled: false,
  };
  const nextNeeds = [...needs, newNeed];
  await persistStockNeeds(parent, nextNeeds);
  return { success: true, needs: nextNeeds };
}

/** Update the editable fields of an existing need. */
export async function updateStockNeedAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
  input: StockNeedInput,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const name = input.name?.trim();
  if (!name) return { success: false, error: "A need name is required." };
  if (name.length > MAX_STOCK_NEED_NAME_LENGTH) {
    return { success: false, error: `Name exceeds ${MAX_STOCK_NEED_NAME_LENGTH} characters.` };
  }
  const note = (input.note ?? "").trim();
  if (note.length > MAX_STOCK_NEED_NOTE_LENGTH) {
    return { success: false, error: `Note exceeds ${MAX_STOCK_NEED_NOTE_LENGTH} characters.` };
  }

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = extractStockNeeds(parent.metadata);
  const target = needs.find((need) => need.id === needId);
  if (!target) return { success: false, error: "Need not found." };

  const nextNeeds = needs.map((need) =>
    need.id === needId
      ? { ...need, name, quantity: normalizeStockNeedQuantity(input.quantity), note }
      : need,
  );
  await persistStockNeeds(parent, nextNeeds);
  return { success: true, needs: nextNeeds };
}

/** Remove a need from the shopping list. */
export async function removeStockNeedAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = extractStockNeeds(parent.metadata);
  if (!needs.some((need) => need.id === needId)) {
    return { success: false, error: "Need not found." };
  }
  const nextNeeds = needs.filter((need) => need.id !== needId);
  await persistStockNeeds(parent, nextNeeds);
  return { success: true, needs: nextNeeds };
}

/** Toggle the `fulfilled` flag on a need. */
export async function toggleStockNeedFulfilledAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = extractStockNeeds(parent.metadata);
  const target = needs.find((need) => need.id === needId);
  if (!target) return { success: false, error: "Need not found." };

  const nextNeeds = needs.map((need) =>
    need.id === needId ? { ...need, fulfilled: !need.fulfilled } : need,
  );
  await persistStockNeeds(parent, nextNeeds);
  return { success: true, needs: nextNeeds };
}

/**
 * Create a public "request" post from a need and mark the need as requested.
 *
 * The post is authored via {@link createPostResource} with {@link PostType.Request},
 * routed into the owning group (`groupId`) when one exists, otherwise posted AS
 * the owning agent (`ownerId`). On success the need's `requested`/`requestedPostId`
 * flags are persisted so the UI can reflect that a request has gone out.
 */
export async function postStockNeedRequestAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
  options?: { federate?: boolean },
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = extractStockNeeds(parent.metadata);
  const target = needs.find((need) => need.id === needId);
  if (!target) return { success: false, error: "Need not found." };

  const result = await createPostResource({
    content: buildNeedRequestText(target),
    postType: PostType.Request,
    ...(parent.postGroupId ? { groupId: parent.postGroupId } : {}),
    ...(parent.postOwnerId ? { ownerId: parent.postOwnerId } : {}),
    federate: options?.federate ?? true,
  });

  if (!result.success) {
    return { success: false, error: result.message || "Failed to post request." };
  }

  const nextNeeds = needs.map((need) =>
    need.id === needId
      ? {
          ...need,
          requested: true,
          ...(result.resourceId ? { requestedPostId: result.resourceId } : {}),
        }
      : need,
  );
  await persistStockNeeds(parent, nextNeeds);
  return { success: true, needs: nextNeeds, ...(result.resourceId ? { postResourceId: result.resourceId } : {}) };
}
