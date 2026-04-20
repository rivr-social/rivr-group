/**
 * Federation authority guard.
 *
 * Peer-side enforcement of signed authority events that originated on global
 * (see rivr-app #88) and were delivered to this instance via
 * `/api/federation/events/import`.
 *
 * Responsibilities:
 * - Answer "is this asserted home still authoritative for agentId?" on the hot path
 *   (session creation, sensitive mutations).
 * - Reject sessions asserted from a revoked home.
 * - Surface the new home when a successor.authority.claim has been received.
 * - Cache answers briefly for non-sensitive reads; no-cache for sensitive ops.
 *
 * Canonical log lives on global (`authority_event_log`); this module reads the
 * local cache populated from import. It must never be the source of truth; it is
 * only a best-effort enforcement projection.
 *
 * Ref: rivr-social/rivr-group #1 / rivr-locale-commons #1 / rivr-bioregional #1;
 * HANDOFF "Recovery Plan" sections 4 + 7.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  AUTHORITY_EVENT_TYPES,
  AUTHORITY_STATUS,
  authorityEventCache,
  type AuthorityEventType,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for non-sensitive guard lookups. Issue #1 acceptance requires <= 60s. */
export const AUTHORITY_GUARD_TTL_MS = 30_000;

/** Reason codes returned by {@link checkAuthorityForSession}. */
export const AUTHORITY_GUARD_REASONS = {
  REVOKED: "revoked",
  SUPERSEDED_BY_SUCCESSOR: "superseded-by-successor",
} as const;

export type AuthorityGuardReason =
  typeof AUTHORITY_GUARD_REASONS[keyof typeof AUTHORITY_GUARD_REASONS];

/** Result shape returned by the guard. */
export interface AuthorityGuardResult {
  allowed: boolean;
  reason?: AuthorityGuardReason;
  newHomeBaseUrl?: string;
}

/** Options accepted by {@link checkAuthorityForSession}. */
export interface AuthorityGuardOptions {
  /**
   * If true, bypass the in-process TTL cache and re-read from the DB.
   * Use on sensitive operations (writes, settings, admin).
   */
  sensitive?: boolean;
}

// ---------------------------------------------------------------------------
// In-process TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: AuthorityGuardResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(agentId: string, homeBaseUrl: string): string {
  return `${agentId}::${normalizeBaseUrl(homeBaseUrl)}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Clears the in-process TTL cache. Exposed for tests and for ops tooling
 * that needs to force re-evaluation after a manual DB change.
 */
export function clearAuthorityGuardCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether `agentId` may act via the asserted `homeBaseUrl`.
 *
 * Wire this at:
 * - Remote session creation (before minting any session cookie/token).
 * - Top of sensitive mutation handlers (with `{ sensitive: true }`).
 *
 * The guard is fail-open on DB errors: if we cannot read the cache, we
 * return `{ allowed: true }` so a transient DB blip does not lock all
 * federated users out. Revocation enforcement on the permanent path is
 * still applied by global and by re-checks on the next request.
 *
 * @param agentId - The asserted actor/agent id.
 * @param homeBaseUrl - The asserted home base URL from the remote assertion.
 * @param options - Optional flags (see {@link AuthorityGuardOptions}).
 * @returns Guard result.
 */
export async function checkAuthorityForSession(
  agentId: string,
  homeBaseUrl: string,
  options: AuthorityGuardOptions = {},
): Promise<AuthorityGuardResult> {
  if (!agentId || !homeBaseUrl) {
    // Invalid input should not be allowed through; let the caller's
    // existing validation produce a 400. We short-circuit defensively.
    return { allowed: false, reason: AUTHORITY_GUARD_REASONS.REVOKED };
  }

  const key = cacheKey(agentId, homeBaseUrl);

  if (!options.sensitive) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  } else {
    // Sensitive ops: clear any stale cache for this key so subsequent
    // non-sensitive reads don't serve an out-of-date answer.
    cache.delete(key);
  }

  const result = await evaluate(agentId, homeBaseUrl);

  if (!options.sensitive) {
    cache.set(key, {
      result,
      expiresAt: Date.now() + AUTHORITY_GUARD_TTL_MS,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

async function evaluate(
  agentId: string,
  homeBaseUrl: string,
): Promise<AuthorityGuardResult> {
  const normalizedAsserted = normalizeBaseUrl(homeBaseUrl);

  let revoke: AuthorityCacheRow | null = null;
  let successor: AuthorityCacheRow | null = null;

  try {
    // Latest revoke + successor claim for this agent. Use the unique
    // (agent_id, event_type) index path.
    revoke = await findLatest(agentId, AUTHORITY_EVENT_TYPES.AUTHORITY_REVOKE);
    successor = await findLatest(
      agentId,
      AUTHORITY_EVENT_TYPES.SUCCESSOR_AUTHORITY_CLAIM,
    );
  } catch (error) {
    console.error(
      "[authority-guard] Failed to read authority_event_cache; failing open:",
      error instanceof Error ? error.message : error,
    );
    return { allowed: true };
  }

  // Revocation beats everything if it targets the asserted home and is
  // not already superseded by a newer successor claim naming a different home.
  if (revoke && normalizeBaseUrl(revoke.homeBaseUrl) === normalizedAsserted) {
    const revokedAt = revoke.receivedAt.getTime();
    const successorAt = successor?.receivedAt.getTime() ?? 0;
    const successorNew = successor?.successorHomeBaseUrl
      ? normalizeBaseUrl(successor.successorHomeBaseUrl)
      : null;

    if (successor && successorAt > revokedAt && successorNew && successorNew !== normalizedAsserted) {
      return {
        allowed: false,
        reason: AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR,
        newHomeBaseUrl: successorNew,
      };
    }

    return { allowed: false, reason: AUTHORITY_GUARD_REASONS.REVOKED };
  }

  // Successor claim whose successor home differs from the asserted home
  // supersedes the old home even without an explicit revoke row.
  if (successor) {
    const successorNew = successor.successorHomeBaseUrl
      ? normalizeBaseUrl(successor.successorHomeBaseUrl)
      : null;
    const priorHome = normalizeBaseUrl(successor.homeBaseUrl);
    if (
      successorNew &&
      priorHome === normalizedAsserted &&
      successorNew !== normalizedAsserted
    ) {
      return {
        allowed: false,
        reason: AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR,
        newHomeBaseUrl: successorNew,
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type AuthorityCacheRow = typeof authorityEventCache.$inferSelect;

async function findLatest(
  agentId: string,
  eventType: AuthorityEventType,
): Promise<AuthorityCacheRow | null> {
  const row = await db.query.authorityEventCache.findFirst({
    where: and(
      eq(authorityEventCache.agentId, agentId),
      eq(authorityEventCache.eventType, eventType),
    ),
    orderBy: [desc(authorityEventCache.receivedAt)],
  });
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Persistence helper — used by /api/federation/events/import
// ---------------------------------------------------------------------------

/**
 * Persist a verified authority event into the local cache, overwriting any
 * prior row for the same (agentId, eventType). Caller is responsible for
 * signature verification (the federation import pipeline already verifies
 * peer signatures before calling this).
 *
 * @returns The derived status that was written.
 */
export async function persistAuthorityEvent(params: {
  agentId: string;
  eventType: AuthorityEventType;
  homeBaseUrl: string;
  homeAuthorityVersion?: number | null;
  credentialVersion?: number | null;
  successorHomeBaseUrl?: string | null;
  signedBy: string;
  signedPayload: Record<string, unknown>;
  signature?: string | null;
}): Promise<{ authorityStatus: string }> {
  const authorityStatus =
    params.eventType === AUTHORITY_EVENT_TYPES.AUTHORITY_REVOKE
      ? AUTHORITY_STATUS.REVOKED
      : params.eventType === AUTHORITY_EVENT_TYPES.SUCCESSOR_AUTHORITY_CLAIM
        ? AUTHORITY_STATUS.SUPERSEDED
        : AUTHORITY_STATUS.ACTIVE;

  const now = new Date();
  await db
    .insert(authorityEventCache)
    .values({
      agentId: params.agentId,
      eventType: params.eventType,
      homeBaseUrl: normalizeBaseUrl(params.homeBaseUrl),
      homeAuthorityVersion: params.homeAuthorityVersion ?? null,
      authorityStatus,
      credentialVersion: params.credentialVersion ?? null,
      successorHomeBaseUrl: params.successorHomeBaseUrl
        ? normalizeBaseUrl(params.successorHomeBaseUrl)
        : null,
      signedBy: params.signedBy,
      signedPayload: params.signedPayload,
      signature: params.signature ?? null,
      receivedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [authorityEventCache.agentId, authorityEventCache.eventType],
      set: {
        homeBaseUrl: normalizeBaseUrl(params.homeBaseUrl),
        homeAuthorityVersion: params.homeAuthorityVersion ?? null,
        authorityStatus,
        credentialVersion: params.credentialVersion ?? null,
        successorHomeBaseUrl: params.successorHomeBaseUrl
          ? normalizeBaseUrl(params.successorHomeBaseUrl)
          : null,
        signedBy: params.signedBy,
        signedPayload: params.signedPayload,
        signature: params.signature ?? null,
        receivedAt: now,
        updatedAt: now,
      },
    });

  // Invalidate cache entries that may now be stale for this agent.
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(`${params.agentId}::`)) {
      cache.delete(key);
    }
  }

  return { authorityStatus };
}

/**
 * Exported list of authority event types recognized by the import pipeline.
 * Re-exported from `@/db/schema` for convenience.
 */
export { AUTHORITY_EVENT_TYPES } from "@/db/schema";

/**
 * Type guard: is the given `eventType` one we recognize on the peer side?
 */
export function isRecognizedAuthorityEventType(
  eventType: string,
): eventType is AuthorityEventType {
  return (Object.values(AUTHORITY_EVENT_TYPES) as string[]).includes(eventType);
}
