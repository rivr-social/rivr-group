/**
 * @fileoverview Provider-mirror `source` block — the provenance contract that
 * connector sync mints onto a mirrored Resource's `metadata.source`.
 *
 * Background (platform-evolution Wave 2 T2.6 / T2.7):
 * Ingested third-party items (Notion pages, Google Drive docs, Gmail messages,
 * Luma events, …) land as RIVR Resources. Each such Resource carries a `source`
 * block describing where it came from, so we can:
 *   - render a backlink to the canonical item (`externalUrl`),
 *   - run last-write-wins on re-sync (`externalUpdatedAt`),
 *   - suppress echoes of our own outbound writes (`provenance` + `externalEtag`
 *     / `contentHash`),
 *   - decide whether writeback is permitted (`syncMode`).
 *
 * Three ingest lanes (T2.6):
 *   - `typed`            — calendar / PM task-graph. These use the dedicated
 *                          `resource_external_sync` SIDECAR table, not this
 *                          metadata block. The lane value is included here only
 *                          so a typed item that ALSO wants an in-metadata mirror
 *                          can describe itself consistently.
 *   - `parachute-mirror` — Drive / Notion / PM-docs. Provenance lives in
 *                          `metadata.source` (this block); no sidecar row.
 *   - `on-demand`        — Gmail single-item save. Same metadata block, one-shot.
 *
 * The field vocabulary deliberately mirrors the `resource_external_sync` sidecar
 * (`provider` / `externalId` / `externalUpdated` / `externalEtag` / `provenance`)
 * so the typed rail and the metadata block stay conceptually interchangeable and
 * the assistant cross-surface action layer (T2.7) can treat them uniformly.
 *
 * No schema change: the block lives inside the existing
 * `resources.metadata` JSONB column under the {@link SOURCE_METADATA_KEY} key.
 */
import { createHash } from "crypto";

/** Metadata key under which the source block is stored on a Resource. */
export const SOURCE_METADATA_KEY = "source" as const;

/** Which ingest lane minted (or owns) this mirrored Resource. */
export type SourceLane = "typed" | "parachute-mirror" | "on-demand";

/** Whether RIVR may write changes back to the provider. */
export type SyncMode = "one-way" | "two-way";

/**
 * Provenance of the most recent successful sync for this Resource. Mirrors the
 * sidecar's vocabulary, but generalized away from Google so it covers any
 * provider's inbound pull:
 * - `rivr_outbound`    — RIVR wrote the provider item (we wrote first).
 * - `provider_inbound` — RIVR mirrored/updated from a provider pull.
 */
export type SourceProvenance = "rivr_outbound" | "provider_inbound";

/**
 * The `source` provenance block attached to a mirrored Resource. All timestamps
 * are ISO-8601 strings so the block round-trips cleanly through JSONB.
 */
export interface SourceBlock {
  /** Connector provider id (e.g. `notion`, `google_drive`, `gmail`, `luma`). */
  provider: string;
  /** Stable id of the item within the provider. */
  externalId: string;
  /** Ingest lane that owns this mirror. */
  lane: SourceLane;
  /** Whether writeback to the provider is permitted. Defaults to `one-way`. */
  syncMode: SyncMode;
  /** Provenance of the most recent successful sync. */
  provenance: SourceProvenance;
  /** Canonical backlink to the item on the provider, when known. */
  externalUrl: string | null;
  /** Provider's last-modified timestamp (ISO) — the last-write-wins basis. */
  externalUpdatedAt: string | null;
  /** Provider concurrency token (etag/version), when the provider supplies one. */
  externalEtag: string | null;
  /**
   * Hash of the synced content body. Used for echo-suppression with providers
   * that do not expose an etag (the next pull that yields the same hash is our
   * own echo and is skipped).
   */
  contentHash: string | null;
  /** ISO timestamp of the first mirror. Preserved across re-syncs. */
  mirroredAt: string;
  /** ISO timestamp of the most recent successful sync. */
  syncedAt: string;
  /** Provider-specific extras (calendarId, workspaceId, databaseId, threadId…). */
  providerMeta: Record<string, unknown>;
}

/** Input to {@link buildSourceBlock}. Only `provider`, `externalId`, `lane` are required. */
export interface BuildSourceBlockInput {
  provider: string;
  externalId: string;
  lane: SourceLane;
  syncMode?: SyncMode;
  provenance?: SourceProvenance;
  externalUrl?: string | null;
  externalUpdatedAt?: string | Date | null;
  externalEtag?: string | null;
  contentHash?: string | null;
  /** Content to hash for echo-suppression (used only when `contentHash` is absent). */
  content?: string | null;
  providerMeta?: Record<string, unknown>;
  /** Override the mint/sync timestamps (defaults to now). */
  now?: Date;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // Normalize provider-supplied strings through Date so we store canonical ISO.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * Computes the SHA-256 hex digest of a content body, for echo-suppression on
 * providers without an etag. Returns `null` for empty/absent content.
 */
export function hashSourceContent(content: string | null | undefined): string | null {
  if (content === null || content === undefined || content === "") return null;
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Builds a normalized {@link SourceBlock} from sync input, filling defaults
 * (`syncMode: one-way`, `provenance: provider_inbound`, `mirroredAt`/`syncedAt`
 * = now) and deriving `contentHash` from `content` when not supplied explicitly.
 */
export function buildSourceBlock(input: BuildSourceBlockInput): SourceBlock {
  const now = (input.now ?? new Date()).toISOString();
  return {
    provider: input.provider,
    externalId: input.externalId,
    lane: input.lane,
    syncMode: input.syncMode ?? "one-way",
    provenance: input.provenance ?? "provider_inbound",
    externalUrl: input.externalUrl ?? null,
    externalUpdatedAt: toIso(input.externalUpdatedAt),
    externalEtag: input.externalEtag ?? null,
    contentHash: input.contentHash ?? hashSourceContent(input.content),
    mirroredAt: now,
    syncedAt: now,
    providerMeta: input.providerMeta ?? {},
  };
}

/**
 * Type guard: returns `true` when `value` is a structurally-valid source block
 * (the two identifying string fields are present).
 */
export function isSourceBlock(value: unknown): value is SourceBlock {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.externalId === "string" &&
    candidate.externalId.length > 0
  );
}

/**
 * Extracts the source block from a Resource's metadata, or `null` when the
 * Resource is not a provider mirror.
 */
export function getSourceBlock(
  metadata: Record<string, unknown> | null | undefined,
): SourceBlock | null {
  if (!metadata) return null;
  const candidate = metadata[SOURCE_METADATA_KEY];
  return isSourceBlock(candidate) ? candidate : null;
}

/**
 * Returns a new metadata object with the source block attached under
 * {@link SOURCE_METADATA_KEY}, leaving the input metadata untouched.
 */
export function withSourceBlock(
  metadata: Record<string, unknown> | null | undefined,
  source: SourceBlock,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [SOURCE_METADATA_KEY]: source };
}

/**
 * Stable dedup key for a mirrored item: `provider:externalId`. Used to map an
 * inbound provider item back to its RIVR Resource and to suppress duplicates.
 */
export function sourceEchoKey(source: Pick<SourceBlock, "provider" | "externalId">): string {
  return `${source.provider}:${source.externalId}`;
}

/** Whether writeback to the provider is permitted for this Resource. */
export function isTwoWay(source: SourceBlock): boolean {
  return source.syncMode === "two-way";
}

/** Incoming provider state evaluated against the stored block. */
export interface IncomingSourceState {
  externalUpdatedAt?: string | Date | null;
  externalEtag?: string | null;
  contentHash?: string | null;
  content?: string | null;
}

/**
 * Decides whether an inbound provider update should be applied to the mirrored
 * Resource, combining echo-suppression with last-write-wins:
 *
 * 1. Echo-suppression — if the incoming etag (or content hash) matches what we
 *    last stored AND our last write was outbound, the pull is our own echo and
 *    is skipped.
 * 2. Last-write-wins — otherwise apply only when the incoming `externalUpdatedAt`
 *    is strictly newer than the stored one. When either side lacks a timestamp,
 *    err toward applying (the provider is authoritative for inbound state).
 */
export function shouldApplyRemoteUpdate(
  source: SourceBlock,
  incoming: IncomingSourceState,
): boolean {
  const incomingHash = incoming.contentHash ?? hashSourceContent(incoming.content);

  // 1. Echo-suppression: same fingerprint as our own last outbound write.
  if (source.provenance === "rivr_outbound") {
    if (incoming.externalEtag && source.externalEtag && incoming.externalEtag === source.externalEtag) {
      return false;
    }
    if (incomingHash && source.contentHash && incomingHash === source.contentHash) {
      return false;
    }
  }

  // 2. Last-write-wins on the provider's modified timestamp.
  const incomingIso = toIso(incoming.externalUpdatedAt);
  if (!incomingIso || !source.externalUpdatedAt) return true;
  return new Date(incomingIso).getTime() > new Date(source.externalUpdatedAt).getTime();
}

/** Patch applied by {@link touchSync} after a successful sync. */
export interface TouchSyncPatch {
  provenance: SourceProvenance;
  externalUpdatedAt?: string | Date | null;
  externalEtag?: string | null;
  contentHash?: string | null;
  content?: string | null;
  externalUrl?: string | null;
  providerMeta?: Record<string, unknown>;
  now?: Date;
}

/**
 * Returns an updated copy of the block after a successful sync: bumps `syncedAt`
 * and records the new provenance/etag/timestamp/hash, while preserving the
 * original `mirroredAt`, `provider`, `externalId`, `lane`, and `syncMode`.
 */
export function touchSync(source: SourceBlock, patch: TouchSyncPatch): SourceBlock {
  const now = (patch.now ?? new Date()).toISOString();
  return {
    ...source,
    provenance: patch.provenance,
    syncedAt: now,
    externalUpdatedAt:
      patch.externalUpdatedAt === undefined
        ? source.externalUpdatedAt
        : toIso(patch.externalUpdatedAt),
    externalEtag: patch.externalEtag === undefined ? source.externalEtag : patch.externalEtag,
    contentHash:
      patch.contentHash !== undefined
        ? patch.contentHash
        : patch.content !== undefined
          ? hashSourceContent(patch.content)
          : source.contentHash,
    externalUrl: patch.externalUrl === undefined ? source.externalUrl : patch.externalUrl,
    providerMeta: patch.providerMeta ? { ...source.providerMeta, ...patch.providerMeta } : source.providerMeta,
  };
}
