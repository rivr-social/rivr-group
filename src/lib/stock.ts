/**
 * @fileoverview Pure helpers and types for the Stock tab (Inventory + Needs).
 *
 * The Stock tab surfaces two things for an org, project, or job:
 *  - Inventory: the tangible material/asset REA resources associated with the
 *    parent object (read-only).
 *  - Needs: an editable shopping list stored in the parent's `metadata.stockNeeds`.
 *
 * This module is intentionally free of `"use server"` and DB imports so its
 * synchronous, pure logic (need-text formatting, metadata parsing, inventory
 * projection) is unit-testable and reusable from both server actions and client
 * components.
 */

/**
 * Tangible-stock REA resource types. These are the material/asset resource
 * kinds — distinct from posts/events/jobs/documents — that make up an object's
 * physical inventory.
 */
export const STOCK_INVENTORY_TYPES = ["resource", "asset"] as const;
export type StockInventoryType = (typeof STOCK_INVENTORY_TYPES)[number];

const STOCK_INVENTORY_TYPE_SET: ReadonlySet<string> = new Set(STOCK_INVENTORY_TYPES);

/**
 * `metadata.resourceKind` values that ride on the generic `resource` type but
 * are NOT tangible pantry stock — bookkeeping/economic rows that share the
 * `resource` DB type. They must never surface on the Inventory subtab:
 *  - `workperiod`: a tracked job-timer segment (job-timer resources carry
 *    `metadata.jobId`, so `getResourcesByJobId` returns them alongside real
 *    stock — they were wrongly rendering as inventory rows).
 *  - `fund`: a named treasury sub-pool (a wallet-bound `resource`, not stock).
 */
export const NON_STOCK_RESOURCE_KINDS = ["workperiod", "fund"] as const;
export type NonStockResourceKind = (typeof NON_STOCK_RESOURCE_KINDS)[number];

const NON_STOCK_RESOURCE_KIND_SET: ReadonlySet<string> = new Set(NON_STOCK_RESOURCE_KINDS);

/** Whether a resource type counts as tangible stock for the Inventory subtab. */
export function isStockInventoryType(type: string | null | undefined): boolean {
  return typeof type === "string" && STOCK_INVENTORY_TYPE_SET.has(type);
}

/**
 * Whether a resource is tangible pantry stock: a stock TYPE whose
 * `metadata.resourceKind` is not one of the non-tangible economic kinds
 * ({@link NON_STOCK_RESOURCE_KINDS}). This is the query/adapter-level gate that
 * keeps work-period timer rows (and treasury funds) out of Inventory.
 */
export function isStockInventoryResource(resource: StockResourceLike): boolean {
  if (!isStockInventoryType(resource.type)) return false;
  const resourceKind = asRecord(resource.metadata).resourceKind;
  return !(typeof resourceKind === "string" && NON_STOCK_RESOURCE_KIND_SET.has(resourceKind));
}

/** The parent object a Stock tab hangs on. */
export type StockParentType = "org" | "project" | "job";

/** A single entry in the editable Needs shopping list. */
export interface StockNeed {
  id: string;
  name: string;
  quantity: number;
  note: string;
  fulfilled: boolean;
  /** Set once a "Post as request" post has been created for this need. */
  requested?: boolean;
  /** Resource id of the request post created for this need, if any. */
  requestedPostId?: string;
}

/** Normalized, display-ready inventory row derived from a stock resource. */
export interface StockInventoryItem {
  id: string;
  name: string;
  imageUrl: string | null;
  quantity: number | null;
  /** Marketplace detail link when the resource is a listing; otherwise null. */
  href: string | null;
}

/** Minimal resource shape consumed by {@link toStockInventoryItem}. */
export interface StockResourceLike {
  id: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown> | null;
}

/** The `metadata` key under which the Needs list is persisted. */
export const STOCK_NEEDS_METADATA_KEY = "stockNeeds";

/** Maximum characters allowed for a need name. */
export const MAX_STOCK_NEED_NAME_LENGTH = 200;
/** Maximum characters allowed for a need note. */
export const MAX_STOCK_NEED_NOTE_LENGTH = 500;
/** Minimum allowed need quantity. */
export const MIN_STOCK_NEED_QUANTITY = 1;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Coerce a raw quantity value into a positive integer, defaulting to
 * {@link MIN_STOCK_NEED_QUANTITY} when absent or invalid.
 */
export function normalizeStockNeedQuantity(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num) || num < MIN_STOCK_NEED_QUANTITY) {
    return MIN_STOCK_NEED_QUANTITY;
  }
  return Math.trunc(num);
}

/**
 * Parse a single raw need object into a fully-typed {@link StockNeed}, or
 * `null` when it lacks the required id/name.
 */
export function parseStockNeed(raw: unknown): StockNeed | null {
  const record = asRecord(raw);
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) return null;
  const note = typeof record.note === "string" ? record.note : "";
  const need: StockNeed = {
    id,
    name,
    quantity: normalizeStockNeedQuantity(record.quantity),
    note,
    fulfilled: record.fulfilled === true,
  };
  if (record.requested === true) need.requested = true;
  if (typeof record.requestedPostId === "string" && record.requestedPostId) {
    need.requestedPostId = record.requestedPostId;
  }
  return need;
}

/**
 * Extract the persisted Needs list from an object's `metadata`, dropping any
 * malformed entries. Always returns a fresh array (never the stored reference).
 */
export function extractStockNeeds(
  metadata: Record<string, unknown> | null | undefined,
): StockNeed[] {
  const raw = asRecord(metadata)[STOCK_NEEDS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseStockNeed(entry))
    .filter((entry): entry is StockNeed => entry !== null);
}

/**
 * Project a tangible-stock resource into a display-ready inventory row.
 *
 * Image resolution mirrors the press-tab convention: `metadata.imageUrl` →
 * `metadata.images[0]` → `metadata.image` → null. Quantity is read from
 * `metadata.quantity` (falling back to `metadata.stockQuantity`) when numeric.
 */
export function toStockInventoryItem(resource: StockResourceLike): StockInventoryItem {
  const metadata = asRecord(resource.metadata);
  const images = Array.isArray(metadata.images) ? metadata.images : [];
  const imageUrl =
    typeof metadata.imageUrl === "string"
      ? metadata.imageUrl
      : typeof images[0] === "string"
        ? (images[0] as string)
        : typeof metadata.image === "string"
          ? (metadata.image as string)
          : null;

  const rawQuantity =
    typeof metadata.quantity === "number"
      ? metadata.quantity
      : typeof metadata.stockQuantity === "number"
        ? metadata.stockQuantity
        : null;
  const quantity =
    rawQuantity !== null && Number.isFinite(rawQuantity) ? rawQuantity : null;

  const href = typeof metadata.listingType === "string" ? `/marketplace/${resource.id}` : null;

  return {
    id: resource.id,
    name: resource.name,
    imageUrl,
    quantity,
    href,
  };
}

/**
 * Project a list of resources into inventory rows, keeping only tangible stock
 * (stock TYPE and not a non-tangible economic `resourceKind` — see
 * {@link isStockInventoryResource}). This is where work-period timer rows and
 * treasury funds are filtered out of Inventory.
 */
export function toStockInventory(resources: StockResourceLike[]): StockInventoryItem[] {
  return resources
    .filter((resource) => isStockInventoryResource(resource))
    .map((resource) => toStockInventoryItem(resource));
}

/**
 * Build the body text for a "Post as request" post created from a need.
 *
 * Format: `Need: {qty>1 ? "{qty}x " : ""}{name}{note ? " — {note}" : ""}`.
 */
export function buildNeedRequestText(need: Pick<StockNeed, "name" | "quantity" | "note">): string {
  const quantity = normalizeStockNeedQuantity(need.quantity);
  const quantityPrefix = quantity > 1 ? `${quantity}x ` : "";
  const name = need.name.trim();
  const note = need.note?.trim();
  const noteSuffix = note ? ` — ${note}` : "";
  return `Need: ${quantityPrefix}${name}${noteSuffix}`;
}
