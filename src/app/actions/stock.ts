"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { canPostToGroup, hasGroupWriteAccess, createPostResource } from "@/app/actions/create-resources";
import { PostType } from "@/lib/types";
import {
  GENERAL_NEEDS_LIST_ID,
  MAX_STOCK_LIST_NAME_LENGTH,
  MAX_STOCK_NEED_NAME_LENGTH,
  MAX_STOCK_NEED_NOTE_LENGTH,
  STOCK_NEEDS_METADATA_KEY,
  STOCK_NEED_LISTS_METADATA_KEY,
  buildNeedRequestText,
  composeNeedLists,
  extractStockNeedLists,
  extractStockNeeds,
  normalizeStockNeedQuantity,
  type StockNeed,
  type StockNeedList,
  type StockParentType,
} from "@/lib/stock";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Uniform result shape for every stock-needs mutation. */
export interface StockNeedsResult {
  success: boolean;
  error?: string;
  needs?: StockNeed[];
  /** All of the parent's need lists after the mutation (General first). */
  lists?: StockNeedList[];
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
  /** Agent that owns inventory materialized from fulfilled needs. */
  inventoryOwnerId: string | null;
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
      inventoryOwnerId: parentId,
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
    inventoryOwnerId: row.ownerId ?? owningGroupId,
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

/** Needs of one list (the General id reads the legacy flat array). */
function listNeeds(metadata: Record<string, unknown>, listId: string): StockNeed[] | null {
  if (listId === GENERAL_NEEDS_LIST_ID) return extractStockNeeds(metadata);
  const list = extractStockNeedLists(metadata).find((entry) => entry.id === listId);
  return list ? list.needs : null;
}

/**
 * Persist one list's needs. The General list keeps writing the LEGACY
 * `stockNeeds` key (zero-migration back-compat); named lists rewrite their
 * entry in `stockNeedLists`.
 */
async function persistListNeeds(
  parent: ResolvedStockParent,
  listId: string,
  needs: StockNeed[],
): Promise<void> {
  if (listId === GENERAL_NEEDS_LIST_ID) {
    await persistStockNeeds(parent, needs);
    return;
  }
  const lists = extractStockNeedLists(parent.metadata).map((entry) =>
    entry.id === listId ? { ...entry, needs } : entry,
  );
  await persistStockMetadata(parent, { [STOCK_NEED_LISTS_METADATA_KEY]: lists });
}

/** Merge keys into the parent's metadata and revalidate its page. */
async function persistStockMetadata(
  parent: ResolvedStockParent,
  patch: Record<string, unknown>,
): Promise<void> {
  const nextMetadata = { ...parent.metadata, ...patch };
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

/** Re-read the parent's fresh lists for the mutation result. */
async function freshLists(parent: ResolvedStockParent, listId: string, needs: StockNeed[]): Promise<StockNeedList[]> {
  // Compose from the in-memory metadata patched with the write we just made —
  // avoids a round-trip and stays consistent with what was persisted.
  const patched = { ...parent.metadata } as Record<string, unknown>;
  if (listId === GENERAL_NEEDS_LIST_ID) {
    patched[STOCK_NEEDS_METADATA_KEY] = needs;
  } else {
    patched[STOCK_NEED_LISTS_METADATA_KEY] = extractStockNeedLists(parent.metadata).map((entry) =>
      entry.id === listId ? { ...entry, needs } : entry,
    );
  }
  return composeNeedLists(patched);
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
  /** Target list; defaults to the legacy General list. */
  listId: string = GENERAL_NEEDS_LIST_ID,
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

  const needs = listNeeds(parent.metadata, listId);
  if (needs === null) return { success: false, error: "List not found." };
  const newNeed: StockNeed = {
    id: randomUUID(),
    name,
    quantity: normalizeStockNeedQuantity(input.quantity),
    note,
    fulfilled: false,
  };
  const nextNeeds = [...needs, newNeed];
  await persistListNeeds(parent, listId, nextNeeds);
  return { success: true, needs: nextNeeds, lists: await freshLists(parent, listId, nextNeeds) };
}

/** Update the editable fields of an existing need. */
export async function updateStockNeedAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
  input: StockNeedInput,
  listId: string = GENERAL_NEEDS_LIST_ID,
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

  const needs = listNeeds(parent.metadata, listId);
  if (needs === null) return { success: false, error: "List not found." };
  const target = needs.find((need) => need.id === needId);
  if (!target) return { success: false, error: "Need not found." };

  const nextNeeds = needs.map((need) =>
    need.id === needId
      ? { ...need, name, quantity: normalizeStockNeedQuantity(input.quantity), note }
      : need,
  );
  await persistListNeeds(parent, listId, nextNeeds);
  return { success: true, needs: nextNeeds, lists: await freshLists(parent, listId, nextNeeds) };
}

/** Remove a need from the shopping list. */
export async function removeStockNeedAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
  listId: string = GENERAL_NEEDS_LIST_ID,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = listNeeds(parent.metadata, listId);
  if (needs === null) return { success: false, error: "List not found." };
  if (!needs.some((need) => need.id === needId)) {
    return { success: false, error: "Need not found." };
  }
  const nextNeeds = needs.filter((need) => need.id !== needId);
  await persistListNeeds(parent, listId, nextNeeds);
  return { success: true, needs: nextNeeds, lists: await freshLists(parent, listId, nextNeeds) };
}

/**
 * Toggle the `fulfilled` flag on a need. Fulfilling a need MATERIALIZES it as
 * a tangible inventory resource on the parent's owning agent (once — the
 * `inventoryResourceId` stamp makes re-toggles idempotent, and un-fulfilling
 * never deletes the physical stock row).
 */
export async function toggleStockNeedFulfilledAction(
  parentType: StockParentType,
  parentId: string,
  needId: string,
  listId: string = GENERAL_NEEDS_LIST_ID,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = listNeeds(parent.metadata, listId);
  if (needs === null) return { success: false, error: "List not found." };
  const target = needs.find((need) => need.id === needId);
  if (!target) return { success: false, error: "Need not found." };

  const nowFulfilled = !target.fulfilled;
  let inventoryResourceId = target.inventoryResourceId;

  if (nowFulfilled && !inventoryResourceId && parent.inventoryOwnerId) {
    const [inventoryRow] = await db
      .insert(resources)
      .values({
        name: target.name,
        description: target.note || `Fulfilled from the ${parentType} needs list.`,
        type: "resource",
        ownerId: parent.inventoryOwnerId,
        visibility: "private",
        metadata: {
          quantity: target.quantity,
          source: "stock-need-fulfilled",
          needId: target.id,
          needListId: listId,
          ...(parent.parentType === "project" ? { projectId: parent.parentId } : {}),
          ...(parent.parentType === "job" ? { jobId: parent.parentId } : {}),
        },
      })
      .returning({ id: resources.id });
    inventoryResourceId = inventoryRow?.id;
  }

  const nextNeeds = needs.map((need) =>
    need.id === needId
      ? {
          ...need,
          fulfilled: nowFulfilled,
          ...(inventoryResourceId ? { inventoryResourceId } : {}),
        }
      : need,
  );
  await persistListNeeds(parent, listId, nextNeeds);
  return { success: true, needs: nextNeeds, lists: await freshLists(parent, listId, nextNeeds) };
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
  options?: { federate?: boolean; listId?: string },
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const listId = options?.listId ?? GENERAL_NEEDS_LIST_ID;
  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const needs = listNeeds(parent.metadata, listId);
  if (needs === null) return { success: false, error: "List not found." };
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
  await persistListNeeds(parent, listId, nextNeeds);
  return { success: true, needs: nextNeeds, lists: await freshLists(parent, listId, nextNeeds), ...(result.resourceId ? { postResourceId: result.resourceId } : {}) };
}

/** All need lists for a parent (General first) — read helper for hydration. */
export async function getStockNeedListsAction(
  parentType: StockParentType,
  parentId: string,
): Promise<StockNeedList[]> {
  if (!UUID_RE.test(parentId)) return [];

  if (parentType === "org") {
    const [org] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, parentId), isNull(agents.deletedAt)))
      .limit(1);
    return org ? composeNeedLists(asRecord(org.metadata)) : [];
  }

  const [row] = await db
    .select({ metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, parentId), isNull(resources.deletedAt)))
    .limit(1);
  return row ? composeNeedLists(asRecord(row.metadata)) : [];
}

/** Create a NAMED needs list (optionally connected to a project). */
export async function createStockNeedListAction(
  parentType: StockParentType,
  parentId: string,
  input: { name: string; projectId?: string },
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };

  const name = input.name?.trim();
  if (!name) return { success: false, error: "A list name is required." };
  if (name.length > MAX_STOCK_LIST_NAME_LENGTH) {
    return { success: false, error: `List name exceeds ${MAX_STOCK_LIST_NAME_LENGTH} characters.` };
  }
  const projectId = input.projectId?.trim();
  if (projectId && !UUID_RE.test(projectId)) {
    return { success: false, error: "Invalid project id." };
  }

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const lists = extractStockNeedLists(parent.metadata);
  const newList: StockNeedList = {
    id: randomUUID(),
    name,
    needs: [],
    ...(projectId ? { projectId } : {}),
  };
  await persistStockMetadata(parent, {
    [STOCK_NEED_LISTS_METADATA_KEY]: [...lists, newList],
  });
  return {
    success: true,
    lists: composeNeedLists({ ...parent.metadata, [STOCK_NEED_LISTS_METADATA_KEY]: [...lists, newList] }),
  };
}

/** Rename a named list and/or change its project connection (null clears). */
export async function updateStockNeedListAction(
  parentType: StockParentType,
  parentId: string,
  listId: string,
  input: { name?: string; projectId?: string | null },
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };
  if (listId === GENERAL_NEEDS_LIST_ID) {
    return { success: false, error: "The General list cannot be renamed or connected." };
  }

  const name = input.name?.trim();
  if (name !== undefined && !name) return { success: false, error: "A list name is required." };
  if (name && name.length > MAX_STOCK_LIST_NAME_LENGTH) {
    return { success: false, error: `List name exceeds ${MAX_STOCK_LIST_NAME_LENGTH} characters.` };
  }
  if (typeof input.projectId === "string" && input.projectId && !UUID_RE.test(input.projectId)) {
    return { success: false, error: "Invalid project id." };
  }

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const lists = extractStockNeedLists(parent.metadata);
  if (!lists.some((entry) => entry.id === listId)) {
    return { success: false, error: "List not found." };
  }
  const nextLists = lists.map((entry) => {
    if (entry.id !== listId) return entry;
    const next = { ...entry };
    if (name) next.name = name;
    if (input.projectId === null) delete next.projectId;
    else if (typeof input.projectId === "string" && input.projectId) next.projectId = input.projectId;
    return next;
  });
  await persistStockMetadata(parent, { [STOCK_NEED_LISTS_METADATA_KEY]: nextLists });
  return {
    success: true,
    lists: composeNeedLists({ ...parent.metadata, [STOCK_NEED_LISTS_METADATA_KEY]: nextLists }),
  };
}

/** Delete a named list (its needs go with it; inventory rows survive). */
export async function removeStockNeedListAction(
  parentType: StockParentType,
  parentId: string,
  listId: string,
): Promise<StockNeedsResult> {
  const userId = await currentUserId();
  if (!userId) return { success: false, error: "Authentication required." };
  if (listId === GENERAL_NEEDS_LIST_ID) {
    return { success: false, error: "The General list cannot be deleted." };
  }

  const parent = await resolveAuthorizedStockParent(parentType, parentId, userId);
  if (typeof parent === "string") return { success: false, error: parent };

  const lists = extractStockNeedLists(parent.metadata);
  if (!lists.some((entry) => entry.id === listId)) {
    return { success: false, error: "List not found." };
  }
  const nextLists = lists.filter((entry) => entry.id !== listId);
  await persistStockMetadata(parent, { [STOCK_NEED_LISTS_METADATA_KEY]: nextLists });
  return {
    success: true,
    lists: composeNeedLists({ ...parent.metadata, [STOCK_NEED_LISTS_METADATA_KEY]: nextLists }),
  };
}

/** One row of the org needs rollup: an agent (the org or a subgroup) with its
 *  own lists and its projects' lists. */
export interface OrgNeedsRollupEntry {
  agentId: string;
  agentName: string;
  /** True for the org itself (first entry). */
  isSelf: boolean;
  lists: StockNeedList[];
  projects: Array<{ projectId: string; projectName: string; lists: StockNeedList[] }>;
}

/**
 * The org Stock tab's hierarchy: the org's own lists, then each visible
 * subgroup's lists, and under each agent the need lists of ITS projects.
 * Read-only; entries with nothing to show are dropped (the org itself always
 * stays so the tab has an anchor).
 */
export async function fetchOrgNeedsRollupAction(
  orgId: string,
): Promise<{ success: boolean; error?: string; rollup?: OrgNeedsRollupEntry[] }> {
  if (!UUID_RE.test(orgId)) return { success: false, error: "Invalid org id." };

  try {
    const [org] = await db
      .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, orgId), isNull(agents.deletedAt)))
      .limit(1);
    if (!org) return { success: false, error: "Organization not found." };

    // Visible org-grade children (share classes are hidden economic subgroups).
    const children = (await db.execute(
      sql`SELECT id, name, metadata FROM agents
          WHERE parent_id = ${orgId}::uuid
            AND deleted_at IS NULL
            AND type = 'organization'
            AND lower(coalesce(metadata->>'groupType', '')) <> 'share_class'
            AND coalesce((metadata->>'hidden')::boolean, false) = false
          ORDER BY name ASC`,
    )) as Array<Record<string, unknown>>;

    const agentsInScope: Array<{ id: string; name: string; metadata: Record<string, unknown>; isSelf: boolean }> = [
      { id: org.id, name: org.name ?? "Organization", metadata: asRecord(org.metadata), isSelf: true },
      ...children.map((child) => ({
        id: String(child.id),
        name: String(child.name ?? "Subgroup"),
        metadata: asRecord(child.metadata),
        isSelf: false,
      })),
    ];

    const rollup: OrgNeedsRollupEntry[] = [];
    for (const agentRow of agentsInScope) {
      const projects = (await db.execute(
        sql`SELECT id, name, metadata FROM resources
            WHERE owner_id = ${agentRow.id}::uuid
              AND deleted_at IS NULL
              AND (type = 'project' OR metadata->>'resourceKind' = 'project')
            ORDER BY name ASC`,
      )) as Array<Record<string, unknown>>;

      // ALL projects are returned (the list-connect picker needs them);
      // display layers filter out projects with nothing to show.
      const projectEntries = projects.map((project) => ({
        projectId: String(project.id),
        projectName: String(project.name ?? "Project"),
        lists: composeNeedLists(asRecord(project.metadata)).filter(
          (list) => list.needs.length > 0 || list.id !== GENERAL_NEEDS_LIST_ID,
        ),
      }));

      const ownLists = agentRow.isSelf
        ? composeNeedLists(agentRow.metadata)
        : composeNeedLists(agentRow.metadata).filter(
            (list) => list.needs.length > 0 || list.id !== GENERAL_NEEDS_LIST_ID,
          );

      if (agentRow.isSelf || ownLists.length > 0 || projectEntries.length > 0) {
        rollup.push({
          agentId: agentRow.id,
          agentName: agentRow.name,
          isSelf: agentRow.isSelf,
          lists: ownLists,
          projects: projectEntries,
        });
      }
    }

    return { success: true, rollup };
  } catch (error) {
    console.error("[fetchOrgNeedsRollupAction] failed:", error);
    return { success: false, error: "Failed to load the needs rollup." };
  }
}
