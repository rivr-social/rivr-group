import { db } from "@/db";
import { manifestReferences } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

export type ManifestReferenceStatus = "active" | "tombstoned" | "revoked" | "expired";

export type ManifestReferenceSummary = {
  title?: string;
  description?: string;
  resourceType?: string;
  visibility?: string;
  tags?: string[];
  ownerId?: string;
  ownerName?: string;
  thumbnailUrl?: string;
  originNodeSlug?: string | null;
  encryptedFacetSummary?: Record<string, unknown>;
  requiredTrustTier?: number;
  trustTier?: number;
};

export type ManifestReferenceInput = {
  originNodeId: string;
  externalEntityId: string;
  entityType: string;
  localEntityId?: string | null;
  manifestUrl?: string | null;
  manifestId?: string | null;
  manifestVersion?: number | null;
  manifestHash?: string | null;
  contentHash?: string | null;
  canonicalUrl?: string | null;
  statusRef?: string | null;
  requiredTrustTier?: number | null;
  trustTier?: number | null;
  status?: ManifestReferenceStatus;
  facetSummary?: Record<string, unknown>;
  encryptedFacetSummary?: Record<string, unknown>;
  sourceFederationEventId?: string | null;
  lastVerifiedAt?: Date | null;
  expiresAt?: Date | null;
};

export type UpsertManifestReferenceResult =
  | { status: "upserted" }
  | { status: "stale"; reason: string; currentVersion: number | null; incomingVersion: number | null };

const MAX_SUMMARY_DESCRIPTION_LENGTH = 360;
const MAX_SUMMARY_TAGS = 12;

function trimString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateSummaryText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= MAX_SUMMARY_DESCRIPTION_LENGTH) return value;
  return `${value.slice(0, MAX_SUMMARY_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function capTags(tags: string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.slice(0, MAX_SUMMARY_TAGS);
}

function normalizeTrustTier(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const tier = Math.trunc(value);
  if (tier < 0) return 0;
  if (tier > 3) return 3;
  return tier;
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = trimString(baseUrl);
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

function sameOriginUrl(value: unknown, originBaseUrl: string | null | undefined): string | undefined {
  const rawUrl = trimString(value);
  const baseUrl = normalizeBaseUrl(originBaseUrl);
  if (!rawUrl || !baseUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    const origin = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.host === origin.host ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function buildCanonicalEntityUrl(params: {
  originBaseUrl: string | null | undefined;
  entityType: string;
  entityId: string;
  resourceType?: string | null;
}): string | null {
  const baseUrl = normalizeBaseUrl(params.originBaseUrl);
  if (!baseUrl) return null;

  if (params.entityType === "agent") return `${baseUrl}/profile/${params.entityId}`;

  if (params.entityType === "resource") {
    if (params.resourceType === "event") return `${baseUrl}/events/${params.entityId}`;
    if (params.resourceType === "project") return `${baseUrl}/projects/${params.entityId}`;
    if (params.resourceType === "listing") return `${baseUrl}/marketplace/${params.entityId}`;
    return `${baseUrl}/posts/${params.entityId}`;
  }

  return `${baseUrl}/${params.entityType}/${params.entityId}`;
}

export function buildStatusRef(params: {
  originBaseUrl: string | null | undefined;
  entityType: string;
  entityId: string;
}): string | null {
  const baseUrl = normalizeBaseUrl(params.originBaseUrl);
  if (!baseUrl) return null;
  const query = new URLSearchParams({
    entityType: params.entityType,
    entityId: params.entityId,
  });
  return `${baseUrl}/api/federation/status?${query.toString()}`;
}

export function buildManifestUrl(params: {
  originBaseUrl: string | null | undefined;
  entityType: string;
  entityId: string;
}): string | null {
  const baseUrl = normalizeBaseUrl(params.originBaseUrl);
  if (!baseUrl) return null;
  return `${baseUrl}/api/universal-manifest/${encodeURIComponent(params.entityType)}/${encodeURIComponent(params.entityId)}`;
}

export function buildResourceManifestReferenceInput(params: {
  originNodeId: string;
  originBaseUrl: string | null;
  originNodeSlug?: string | null;
  externalEntityId: string;
  localEntityId?: string | null;
  sourceFederationEventId?: string | null;
  manifestVersion?: number | null;
  payload: Record<string, unknown>;
  resourceType: string;
  visibility: string;
  requiredTrustTier?: number | null;
  trustTier?: number | null;
  encryptedFacetSummary?: Record<string, unknown> | null;
  title: string;
  description?: string | null;
  tags?: string[];
  ownerId?: string | null;
  ownerName?: string | null;
}): ManifestReferenceInput {
  const manifestUrl = buildManifestUrl({
    originBaseUrl: params.originBaseUrl,
    entityType: "resource",
    entityId: params.externalEntityId,
  });
  const canonicalUrl = buildCanonicalEntityUrl({
    originBaseUrl: params.originBaseUrl,
    entityType: "resource",
    entityId: params.externalEntityId,
    resourceType: params.resourceType,
  });
  const statusRef = buildStatusRef({
    originBaseUrl: params.originBaseUrl,
    entityType: "resource",
    entityId: params.externalEntityId,
  });
  const requiredTrustTier =
    normalizeTrustTier(params.requiredTrustTier) ??
    normalizeTrustTier((params.payload.metadata as Record<string, unknown> | undefined)?.requiredTrustTier) ??
    normalizeTrustTier(params.payload.requiredTrustTier) ??
    0;
  const trustTier =
    normalizeTrustTier(params.trustTier) ??
    normalizeTrustTier((params.payload.metadata as Record<string, unknown> | undefined)?.trustTier) ??
    0;
  const encryptedFacetSummary =
    params.encryptedFacetSummary ??
    ((params.payload.encryptedFacets && typeof params.payload.encryptedFacets === "object" && !Array.isArray(params.payload.encryptedFacets)
      ? (params.payload.encryptedFacets as Record<string, unknown>)
      : undefined) ??
      (params.payload.sealedFacets && typeof params.payload.sealedFacets === "object" && !Array.isArray(params.payload.sealedFacets)
        ? (params.payload.sealedFacets as Record<string, unknown>)
        : undefined));

  const facetSummary: ManifestReferenceSummary = {
    title: params.title,
    description: truncateSummaryText(params.description),
    resourceType: params.resourceType,
    visibility: params.visibility,
    tags: capTags(params.tags),
    ownerId: params.ownerId ?? undefined,
    ownerName: params.ownerName ?? undefined,
    thumbnailUrl:
      sameOriginUrl(params.payload.thumbnailUrl, params.originBaseUrl) ??
      sameOriginUrl(params.payload.image, params.originBaseUrl),
    originNodeSlug: params.originNodeSlug ?? null,
    requiredTrustTier,
    trustTier,
    ...(encryptedFacetSummary ? { encryptedFacetSummary } : {}),
  };

  return {
    originNodeId: params.originNodeId,
    externalEntityId: params.externalEntityId,
    localEntityId: params.localEntityId ?? params.externalEntityId,
    entityType: "resource",
    manifestUrl,
    manifestId: trimString(params.payload.manifestId),
    manifestVersion: params.manifestVersion ?? null,
    manifestHash: trimString(params.payload.manifestHash),
    contentHash: trimString(params.payload.contentHash),
    canonicalUrl,
    statusRef,
    requiredTrustTier,
    trustTier,
    status: "active",
    facetSummary: Object.fromEntries(
      Object.entries(facetSummary).filter(([, value]) => value !== undefined),
    ),
    encryptedFacetSummary: encryptedFacetSummary ?? {},
    sourceFederationEventId: params.sourceFederationEventId ?? null,
  };
}

export type ActiveResourcePointer = {
  canonicalUrl: string;
  originNodeId: string;
};

/**
 * Resolve the active canonical origin pointer for a federated resource.
 *
 * Phase 5 reference-mode read helper: given the id used in a local resource
 * URL (the origin's external entity id, which both the resource-cards
 * projection and the direct importer record as the manifest reference key),
 * return the canonical origin URL when an active manifest reference exists.
 *
 * Returns null when the resource is purely local (no manifest reference) or
 * when the reference is tombstoned/revoked/expired or carries no canonical
 * URL — callers then fall back to rendering the local copy exactly as before.
 */
export async function resolveActiveResourcePointer(
  externalEntityId: string,
): Promise<ActiveResourcePointer | null> {
  const reference = await db.query.manifestReferences.findFirst({
    where: and(
      eq(manifestReferences.entityType, "resource"),
      eq(manifestReferences.externalEntityId, externalEntityId),
      eq(manifestReferences.status, "active"),
    ),
    columns: { canonicalUrl: true, originNodeId: true },
  });

  const canonicalUrl = trimString(reference?.canonicalUrl);
  if (!reference || !canonicalUrl) return null;
  return { canonicalUrl, originNodeId: reference.originNodeId };
}

export function getResourceReferenceKey(
  resourceId: string,
  metadata?: Record<string, unknown> | null,
): string {
  const externalEntityId = metadata && typeof metadata.externalEntityId === "string"
    ? metadata.externalEntityId.trim()
    : "";
  return externalEntityId.length > 0 ? externalEntityId : resourceId;
}

export async function resolveActiveResourcePointerForResource(
  resourceId: string,
  metadata?: Record<string, unknown> | null,
): Promise<ActiveResourcePointer | null> {
  return resolveActiveResourcePointer(getResourceReferenceKey(resourceId, metadata));
}

export async function upsertManifestReference(
  input: ManifestReferenceInput,
): Promise<UpsertManifestReferenceResult> {
  const existing = await db.query.manifestReferences.findFirst({
    where: and(
      eq(manifestReferences.originNodeId, input.originNodeId),
      eq(manifestReferences.externalEntityId, input.externalEntityId),
      eq(manifestReferences.entityType, input.entityType),
    ),
    columns: { id: true, manifestVersion: true, status: true },
  });

  const incomingVersion = input.manifestVersion ?? null;
  const currentVersion = existing?.manifestVersion ?? null;
  const currentStatus = existing?.status ?? null;
  if (
    currentVersion != null &&
    (incomingVersion == null || incomingVersion <= currentVersion)
  ) {
    return {
      status: "stale",
      reason: incomingVersion == null ? "missing_manifest_version" : "older_or_equal_manifest_version",
      currentVersion,
      incomingVersion,
    };
  }
  if (
    existing &&
    (currentStatus === "tombstoned" || currentStatus === "revoked") &&
    incomingVersion == null
  ) {
    return {
      status: "stale",
      reason: "cannot_reactivate_terminal_status_without_version",
      currentVersion,
      incomingVersion,
    };
  }

  const now = new Date();
  await db
    .insert(manifestReferences)
    .values({
      originNodeId: input.originNodeId,
      externalEntityId: input.externalEntityId,
      localEntityId: input.localEntityId ?? null,
      entityType: input.entityType,
      manifestUrl: input.manifestUrl ?? null,
      manifestId: input.manifestId ?? null,
      manifestVersion: input.manifestVersion ?? null,
      manifestHash: input.manifestHash ?? null,
      contentHash: input.contentHash ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      statusRef: input.statusRef ?? null,
      requiredTrustTier: input.requiredTrustTier ?? 0,
      trustTier: input.trustTier ?? 0,
      status: input.status ?? "active",
      facetSummary: input.facetSummary ?? {},
      encryptedFacetSummary: input.encryptedFacetSummary ?? {},
      sourceFederationEventId: input.sourceFederationEventId ?? null,
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      lastSeenAt: now,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        manifestReferences.originNodeId,
        manifestReferences.externalEntityId,
        manifestReferences.entityType,
      ],
      set: {
        localEntityId: input.localEntityId ?? null,
        manifestUrl: input.manifestUrl ?? null,
        manifestId: input.manifestId ?? null,
        manifestVersion: input.manifestVersion ?? null,
        manifestHash: input.manifestHash ?? null,
        contentHash: input.contentHash ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        statusRef: input.statusRef ?? null,
        requiredTrustTier: input.requiredTrustTier ?? 0,
        trustTier: input.trustTier ?? 0,
        status: input.status ?? "active",
        facetSummary: input.facetSummary ?? {},
        encryptedFacetSummary: input.encryptedFacetSummary ?? {},
        sourceFederationEventId: input.sourceFederationEventId ?? null,
        lastVerifiedAt: input.lastVerifiedAt ?? null,
        lastSeenAt: now,
        expiresAt: input.expiresAt ?? null,
        revokedAt: input.status === "revoked" ? now : null,
        updatedAt: now,
      },
      setWhere: sql`${manifestReferences.manifestVersion} IS NULL OR excluded.manifest_version > ${manifestReferences.manifestVersion}`,
    });

  return { status: "upserted" };
}

export async function tombstoneManifestReference(params: {
  originNodeId: string;
  externalEntityId: string;
  entityType: string;
  manifestVersion?: number | null;
  sourceFederationEventId?: string | null;
}): Promise<UpsertManifestReferenceResult> {
  const existing = await db.query.manifestReferences.findFirst({
    where: and(
      eq(manifestReferences.originNodeId, params.originNodeId),
      eq(manifestReferences.externalEntityId, params.externalEntityId),
      eq(manifestReferences.entityType, params.entityType),
    ),
    columns: { id: true, manifestVersion: true },
  });
  const incomingVersion = params.manifestVersion ?? null;
  const currentVersion = existing?.manifestVersion ?? null;
  if (
    currentVersion != null &&
    (incomingVersion == null || incomingVersion <= currentVersion)
  ) {
    return {
      status: "stale",
      reason: incomingVersion == null ? "missing_manifest_version" : "older_or_equal_manifest_version",
      currentVersion,
      incomingVersion,
    };
  }

  const now = new Date();
  await db
    .insert(manifestReferences)
    .values({
      originNodeId: params.originNodeId,
      externalEntityId: params.externalEntityId,
      entityType: params.entityType,
      manifestVersion: params.manifestVersion ?? null,
      status: "tombstoned",
      facetSummary: {},
      encryptedFacetSummary: {},
      sourceFederationEventId: params.sourceFederationEventId ?? null,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        manifestReferences.originNodeId,
        manifestReferences.externalEntityId,
        manifestReferences.entityType,
      ],
      set: {
        manifestVersion: params.manifestVersion ?? null,
        status: "tombstoned",
        encryptedFacetSummary: {},
        sourceFederationEventId: params.sourceFederationEventId ?? null,
        lastSeenAt: now,
        updatedAt: now,
      },
      setWhere: sql`${manifestReferences.manifestVersion} IS NULL OR excluded.manifest_version > ${manifestReferences.manifestVersion}`,
    });
  return { status: "upserted" };
}
