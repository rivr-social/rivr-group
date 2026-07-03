/**
 * @fileoverview Parachute doc schema + faceted-tag virtual filesystem (Wave 2 / T2.5).
 *
 * A "Parachute doc" is a Data Resource shaped as `{ body: markdown, tags: TagPath[] }`.
 * Each {@link TagPath} is an ordered list of segments describing a position in ONE
 * orthogonal hierarchy (e.g. `["work","projects","rivr"]`). A doc may carry many
 * tag-paths from independent hierarchies, so the same doc surfaces under multiple
 * virtual folders at once. Tags are an OVERLAY/INDEX — they are not ownership and
 * not ACL; visibility/permissions remain on the Resource row itself.
 *
 * Persistence: faceted tag-paths live in `resources.metadata.facetedTags` (a JSONB
 * `string[][]`). No schema migration is required — this keeps existing rows valid
 * and matches how document metadata is already stored. The flat `resources.tags`
 * text[] column is kept in sync via {@link flattenFacetedTags} so the existing tag
 * index and search continue to work.
 *
 * This module is PURE: no database, no Node-only APIs. It is safe to import from
 * both client and server code (the virtual-FS builder runs on either side).
 */

/** A single position in one orthogonal hierarchy, root-first. */
export type TagPath = string[];

/** Canonical Parachute doc payload. */
export interface ParachuteDoc {
  body: string;
  tags: TagPath[];
}

/** A document leaf placed into the faceted virtual filesystem. */
export interface FacetedDoc {
  id: string;
  name: string;
  tags: TagPath[];
}

/** A leaf node in the faceted tree (a document at a facet position). */
export interface FacetLeafNode {
  type: "doc";
  /** Stable per-placement id: `${docId}@${facetPath}`. */
  id: string;
  docId: string;
  name: string;
}

/** A folder node in the faceted tree (a facet path-prefix). */
export interface FacetFolderNode {
  type: "facet";
  /** Stable id: the full materialized path to this folder. */
  id: string;
  /** This folder's own segment label. */
  name: string;
  /** Materialized path from the root, segments joined by {@link FACET_PATH_SEPARATOR}. */
  path: string;
  children: FacetTreeNode[];
  docCount: number;
}

export type FacetTreeNode = FacetFolderNode | FacetLeafNode;

/** Metadata key under which faceted tag-paths are persisted on a Resource. */
export const FACETED_TAGS_METADATA_KEY = "facetedTags";

/** Separator used when materializing a tag-path into a single string. */
export const FACET_PATH_SEPARATOR = "/";

/** Synthetic folder collecting docs that carry no faceted tags. */
export const UNTAGGED_FACET_LABEL = "Untagged";

/** Hard caps to keep a single doc's facet set bounded and the tree well-formed. */
export const MAX_TAG_PATHS = 64;
export const MAX_TAG_DEPTH = 12;
export const MAX_SEGMENT_LENGTH = 120;

/**
 * Normalizes arbitrary faceted-tag input into a clean, deterministic
 * `TagPath[]`.
 *
 * Accepts either:
 *  - `string[][]` — each inner array is a tag-path of segments, or
 *  - `string[]`   — each string is a materialized path split on
 *    {@link FACET_PATH_SEPARATOR} (so flat tags like `"work/projects"` are
 *    promoted to a tag-path), or
 *  - `string`     — a single materialized path.
 *
 * Each segment is trimmed and lower-cased (Parachute/Obsidian fold tags to
 * lower-case in both `extractInlineTags` and `extractFrontmatterTags`, so a
 * tag typed in the RIVR UI as `Work/Projects` is the SAME facet as an imported
 * `work/projects` and the two never split the tag tree — this is what keeps
 * straight-from-vault imports round-tripping). Empty segments are dropped.
 * Paths are truncated to {@link MAX_TAG_DEPTH} segments (each capped at
 * {@link MAX_SEGMENT_LENGTH} chars). Empty paths are removed, exact duplicates
 * are collapsed, and the result is sorted for stable storage and rendering.
 */
export function normalizeFacetedTags(input: unknown): TagPath[] {
  const rawPaths: unknown[] = toRawPathList(input);

  const seen = new Set<string>();
  const normalized: TagPath[] = [];

  for (const rawPath of rawPaths) {
    const segments = toSegments(rawPath);
    if (segments.length === 0) continue;

    const key = segments.join(FACET_PATH_SEPARATOR);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(segments);

    if (normalized.length >= MAX_TAG_PATHS) break;
  }

  normalized.sort((a, b) =>
    a.join(FACET_PATH_SEPARATOR).localeCompare(b.join(FACET_PATH_SEPARATOR)),
  );
  return normalized;
}

/**
 * Projects faceted tag-paths into the flat `string[]` stored in the
 * `resources.tags` column. Each materialized path AND each individual segment
 * is emitted (deduped), so existing tag-equality search keeps matching on both
 * full paths (`"work/projects"`) and bare segments (`"projects"`).
 */
export function flattenFacetedTags(tags: TagPath[]): string[] {
  const flat = new Set<string>();
  for (const path of tags) {
    if (path.length === 0) continue;
    flat.add(path.join(FACET_PATH_SEPARATOR));
    for (const segment of path) {
      flat.add(segment);
    }
  }
  return [...flat].sort((a, b) => a.localeCompare(b));
}

/**
 * Reads and normalizes faceted tag-paths from a Resource's metadata. Falls back
 * to deriving depth-1 facets from the supplied flat tags when the metadata
 * carries none, so legacy docs still appear in the virtual FS.
 */
export function parseFacetedTagsFromMetadata(
  metadata: unknown,
  fallbackFlatTags?: readonly string[] | null,
): TagPath[] {
  const fromMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)[FACETED_TAGS_METADATA_KEY]
      : undefined;

  const normalized = normalizeFacetedTags(fromMetadata);
  if (normalized.length > 0) return normalized;

  if (fallbackFlatTags && fallbackFlatTags.length > 0) {
    return normalizeFacetedTags([...fallbackFlatTags]);
  }
  return [];
}

/**
 * Returns a shallow copy of `metadata` with the normalized faceted tag-paths
 * written under {@link FACETED_TAGS_METADATA_KEY}. The key is omitted entirely
 * when there are no tags so we never persist an empty array.
 */
export function serializeFacetedTagsToMetadata(
  metadata: Record<string, unknown> | null | undefined,
  tags: TagPath[],
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(metadata ?? {}) };
  const normalized = normalizeFacetedTags(tags);
  if (normalized.length === 0) {
    delete base[FACETED_TAGS_METADATA_KEY];
    return base;
  }
  base[FACETED_TAGS_METADATA_KEY] = normalized;
  return base;
}

/**
 * Derives faceted tag-paths from a vault-style file path (the folder structure
 * IS the hierarchy). `"work/projects/rivr/spec.md"` →
 * `[["work","projects","rivr"]]`. The filename is dropped; leading/trailing
 * slashes and `.`/`..` segments are ignored. A file at the vault root yields no
 * facets.
 */
export function facetedTagsFromVaultPath(path: string): TagPath[] {
  const segments = path
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  // Drop the filename — only the containing folders form the hierarchy.
  const folderSegments = segments.slice(0, -1);
  if (folderSegments.length === 0) return [];
  return normalizeFacetedTags([folderSegments]);
}

/**
 * Builds the faceted virtual filesystem from a set of docs.
 *
 * For each doc, every tag-path places the doc as a leaf under the folder reached
 * by that path, creating folder nodes for every prefix along the way. Because a
 * doc may carry tag-paths from several independent hierarchies, the same doc can
 * appear under multiple top-level folders — this is the intended overlay/index
 * behaviour, not duplication of the underlying Resource.
 *
 * Docs with no tag-paths are collected under a single {@link UNTAGGED_FACET_LABEL}
 * folder. Folders are sorted alphabetically; leaves sort by name then docId.
 * `docCount` on each folder counts the distinct docs reachable in its subtree.
 */
export function buildFacetedTree(docs: readonly FacetedDoc[]): FacetTreeNode[] {
  const root = newFolder("", "");
  const untagged = newFolder(UNTAGGED_FACET_LABEL, UNTAGGED_FACET_LABEL);

  for (const doc of docs) {
    const tags = normalizeFacetedTags(doc.tags);
    if (tags.length === 0) {
      addLeaf(untagged, doc, UNTAGGED_FACET_LABEL);
      continue;
    }
    for (const path of tags) {
      let cursor = root;
      let materialized = "";
      for (const segment of path) {
        materialized = materialized
          ? `${materialized}${FACET_PATH_SEPARATOR}${segment}`
          : segment;
        cursor = descend(cursor, segment, materialized);
      }
      addLeaf(cursor, doc, materialized);
    }
  }

  const top: FolderBuilder[] = [...root.folders.values()];
  if (untagged.leaves.length > 0) {
    top.push(untagged);
  }

  return top
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => finalizeFolder(folder));
}

// --- internal builder scaffolding ---------------------------------------------

/** Mutable folder used while assembling the tree; converted by finalizeFolder. */
interface FolderBuilder {
  name: string;
  path: string;
  folders: Map<string, FolderBuilder>;
  leaves: FacetLeafNode[];
  children: Array<FolderBuilder | FacetLeafNode>;
  docIds: Set<string>;
}

function newFolder(name: string, path: string): FolderBuilder {
  return {
    name,
    path,
    folders: new Map(),
    leaves: [],
    children: [],
    docIds: new Set(),
  };
}

function descend(parent: FolderBuilder, segment: string, path: string): FolderBuilder {
  const existing = parent.folders.get(segment);
  if (existing) return existing;
  const child = newFolder(segment, path);
  parent.folders.set(segment, child);
  parent.children.push(child);
  return child;
}

function addLeaf(folder: FolderBuilder, doc: FacetedDoc, facetPath: string): void {
  // Tally the doc into this folder and every ancestor implicitly via the
  // finalize pass; here we just record the placement and the direct membership.
  if (!folder.docIds.has(doc.id)) {
    folder.docIds.add(doc.id);
  }
  folder.leaves.push({
    type: "doc",
    id: `${doc.id}@${facetPath}`,
    docId: doc.id,
    name: doc.name,
  });
}

function finalizeFolder(folder: FolderBuilder): FacetFolderNode {
  const childFolders = [...folder.folders.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => finalizeFolder(child));

  const leaves = [...folder.leaves].sort(
    (a, b) => a.name.localeCompare(b.name) || a.docId.localeCompare(b.docId),
  );

  const distinctDocIds = new Set<string>(folder.docIds);
  for (const child of childFolders) {
    accumulateDocIds(child, distinctDocIds);
  }

  const children: FacetTreeNode[] = [...childFolders, ...leaves];

  return {
    type: "facet",
    id: folder.path || UNTAGGED_FACET_LABEL,
    name: folder.name,
    path: folder.path,
    children,
    docCount: distinctDocIds.size,
  };
}

function accumulateDocIds(node: FacetFolderNode, into: Set<string>): void {
  for (const child of node.children) {
    if (child.type === "doc") {
      into.add(child.docId);
    } else {
      accumulateDocIds(child, into);
    }
  }
}

// --- normalization helpers ----------------------------------------------------

function toRawPathList(input: unknown): unknown[] {
  if (input == null) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input;
  return [];
}

function toSegments(rawPath: unknown): string[] {
  let parts: unknown[];
  if (typeof rawPath === "string") {
    parts = rawPath.split(FACET_PATH_SEPARATOR);
  } else if (Array.isArray(rawPath)) {
    parts = rawPath;
  } else {
    return [];
  }

  const segments: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Fold to lower-case to match Parachute's tag normalization exactly, so
    // UI-typed and vault-imported tags resolve to one canonical facet.
    segments.push(trimmed.toLowerCase().slice(0, MAX_SEGMENT_LENGTH));
    if (segments.length >= MAX_TAG_DEPTH) break;
  }
  return segments;
}
