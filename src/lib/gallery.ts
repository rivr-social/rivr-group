/**
 * Gallery media collection, filtering, de-duplication, and sorting helpers.
 *
 * Purpose:
 * - Provide a single, pure (side-effect-free) source of truth for turning an
 *   entity's media-bearing data (profile photos, post images, image/video
 *   Resources, listing/offering images) into an ordered, de-duplicated list of
 *   gallery items.
 * - Shared by BOTH user profiles and group pages so the gallery behaves
 *   identically for both entity types (global homes both first-class users AND
 *   groups).
 *
 * Source model (matched to existing convention):
 * - Does NOT introduce a new storage model. Media is sourced from the SAME
 *   places the existing inline "photos" tab already drew from:
 *     1. `metadata.profilePhotos` (string[] of uploaded image URLs)
 *     2. Post resources' `images` arrays / `metadata.images`
 *     3. Resource rows: `image`/`video` typed rows (use `url`), and any
 *        resource carrying `metadata.images` / `metadata.imageUrl`.
 * - The DB `resource_type` enum includes `image` and `video`; those rows store
 *   their media at `resources.url`.
 *
 * Key exports:
 * - `GalleryItem` — normalized gallery entry.
 * - `collectGalleryItems` — build a sorted, de-duplicated gallery from sources.
 * - `extractResourceImages` — pull candidate image URLs out of one resource.
 */

/** Maximum number of items a gallery will surface. */
export const MAX_GALLERY_ITEMS = 120;

/** Media kind for a gallery item. */
export type GalleryMediaKind = "image" | "video";

/** A single normalized gallery entry, ready to render. */
export interface GalleryItem {
  /** Stable, de-dup key for React lists (derived from source id + src). */
  readonly key: string;
  /** Media URL. */
  readonly src: string;
  /** Human-readable caption/label. */
  readonly label: string;
  /** Media kind (image vs video). */
  readonly kind: GalleryMediaKind;
  /** ISO timestamp used for newest-first sorting. */
  readonly createdAt: string;
  /** Originating source id (post id, resource id, or synthetic). */
  readonly sourceId: string;
}

/** Minimal resource shape this module reads (subset of the DB Resource). */
export interface GallerySourceResource {
  readonly id: string;
  readonly name?: string | null;
  readonly type?: string | null;
  readonly url?: string | null;
  readonly contentType?: string | null;
  readonly createdAt?: string | Date | null;
  readonly metadata?: Record<string, unknown> | null;
}

/** Minimal post shape this module reads. */
export interface GallerySourcePost {
  readonly id: string;
  readonly content?: string | null;
  readonly images?: string[] | null;
  readonly createdAt?: string | Date | null;
  readonly timestamp?: string | Date | null;
}

/** Stable fallback timestamp for entries with no usable date. */
const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/** File extensions treated as video when no contentType is present. */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".ogv"];

/** Caption length cap so long post bodies don't blow out gallery labels. */
const MAX_LABEL_LENGTH = 80;

/** Coerces a date-ish value to an ISO string, falling back deterministically. */
function toIsoTimestamp(value: string | Date | null | undefined): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return FALLBACK_TIMESTAMP;
}

/** Trims and length-caps a label, returning a fallback when empty. */
function toLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…` : trimmed;
}

/** Determines whether a URL/contentType pair represents a video. */
function inferMediaKind(src: string, contentType?: string | null, resourceType?: string | null): GalleryMediaKind {
  if (resourceType === "video") return "video";
  if (typeof contentType === "string" && contentType.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const lower = src.toLowerCase().split("?")[0];
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return "image";
}

/** Type guard for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Extracts candidate media URLs from a single resource, looking at (in order):
 * the typed image/video `url`, `metadata.images`, `metadata.imageUrl`, and a
 * generic `url` fallback. De-duplicates within the resource.
 *
 * @param resource A resource-like source object.
 * @returns Ordered, de-duplicated candidate URLs for this resource.
 */
export function extractResourceImages(resource: GallerySourceResource): string[] {
  const meta = (resource.metadata && typeof resource.metadata === "object" ? resource.metadata : {}) as Record<string, unknown>;
  const candidates: string[] = [];

  // Typed image/video resources store media directly at `url`.
  if ((resource.type === "image" || resource.type === "video") && isNonEmptyString(resource.url)) {
    candidates.push(resource.url);
  }

  if (Array.isArray(meta.images)) {
    for (const value of meta.images) {
      if (isNonEmptyString(value)) candidates.push(value);
    }
  }
  if (isNonEmptyString(meta.imageUrl)) candidates.push(meta.imageUrl);
  if (isNonEmptyString(meta.coverImage)) candidates.push(meta.coverImage);
  if (isNonEmptyString(resource.url)) candidates.push(resource.url);

  // De-duplicate while preserving order.
  return Array.from(new Set(candidates));
}

/** Input sources for {@link collectGalleryItems}. */
export interface GallerySources {
  /** Direct uploaded photo URLs (e.g. `metadata.profilePhotos`). */
  readonly profilePhotos?: readonly string[];
  /** Timestamp to attribute to `profilePhotos` (e.g. join date). */
  readonly profilePhotosTimestamp?: string | Date | null;
  /** Post resources whose `images` should be included. */
  readonly posts?: readonly GallerySourcePost[];
  /** General resources (image/video/listing/offering, etc.). */
  readonly resources?: readonly GallerySourceResource[];
  /** Max items to return. Defaults to {@link MAX_GALLERY_ITEMS}. */
  readonly limit?: number;
}

/**
 * Builds an ordered, de-duplicated gallery from heterogeneous media sources.
 *
 * Ordering: newest-first by `createdAt`. De-duplication: by media `src`
 * (first occurrence wins, so earlier sources take precedence). The result is
 * capped at `limit`.
 *
 * @param sources Profile photos, posts, and resources to draw media from.
 * @returns Sorted, de-duplicated `GalleryItem[]` capped at the limit.
 */
export function collectGalleryItems(sources: GallerySources): GalleryItem[] {
  const limit = sources.limit ?? MAX_GALLERY_ITEMS;
  const seen = new Set<string>();
  const items: GalleryItem[] = [];

  const push = (
    src: string,
    label: string,
    sourceId: string,
    createdAt: string,
    contentType?: string | null,
    resourceType?: string | null
  ) => {
    if (!isNonEmptyString(src) || seen.has(src)) return;
    seen.add(src);
    items.push({
      key: `${sourceId}::${src}`,
      src,
      label,
      sourceId,
      createdAt,
      kind: inferMediaKind(src, contentType, resourceType),
    });
  };

  // 1. Direct uploaded profile photos (highest precedence).
  const photosTimestamp = toIsoTimestamp(sources.profilePhotosTimestamp);
  (sources.profilePhotos ?? []).forEach((src, index) => {
    push(src, "Profile photo", `profile-photo-${index}`, photosTimestamp);
  });

  // 2. Post images.
  for (const post of sources.posts ?? []) {
    const createdAt = toIsoTimestamp(post.createdAt ?? post.timestamp);
    for (const image of post.images ?? []) {
      push(image, toLabel(post.content, "Post image"), post.id, createdAt);
    }
  }

  // 3. Resource media (image/video rows, listings, offerings, etc.).
  for (const resource of sources.resources ?? []) {
    const createdAt = toIsoTimestamp(resource.createdAt);
    for (const image of extractResourceImages(resource)) {
      push(
        image,
        toLabel(resource.name, "Media"),
        resource.id,
        createdAt,
        resource.contentType,
        resource.type
      );
    }
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return items.slice(0, limit);
}
