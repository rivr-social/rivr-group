/**
 * FEDERATION REVOCATION CONTRACT — shared-manifest file (canonical: global;
 * edit HERE and sync outward with tools/shared-sync.sh; parity is enforced
 * inside the drift guard).
 *
 * Scope: NAMES + payload shape ONLY, mirroring mutation-contract.ts's
 * philosophy. These are the event types every instance must treat as a
 * RETRACTION of previously-federated content: on import, the local
 * projection/mirror is soft-deleted and any manifest reference card is
 * tombstoned + stamped `revoked_at`. A retraction is TERMINAL and MONOTONIC —
 * receivers must never version-gate it away (there is no such thing as a
 * stale delete).
 *
 * Why this exists (2026-08-05): a home deleting content never told instances
 * holding federated reference cards, so deleted content lingered remotely for
 * months (the July feed-purge class). The emit sites and consumer branches
 * live per-repo; this file is the vocabulary they may not fork.
 */

/** Event types that retract a RESOURCE-class entity (posts/events/listings/docs). */
export const RESOURCE_REVOCATION_EVENT_TYPES = [
  'resource.deleted',
  'post.deleted',
  'event.deleted',
  'event.cancelled',
  'delete', // legacy wire name still emitted by old peers
] as const;

/** Event types that retract an AGENT-class entity (personas, groups, accounts). */
export const AGENT_REVOCATION_EVENT_TYPES = ['agent.deleted'] as const;

export type ResourceRevocationEventType = (typeof RESOURCE_REVOCATION_EVENT_TYPES)[number];
export type AgentRevocationEventType = (typeof AGENT_REVOCATION_EVENT_TYPES)[number];

/**
 * The revocation payload every emitter stamps. `id` is MANDATORY — receivers
 * fall back to the envelope entityId, but a payload that names its entity
 * survives envelope rewrites (the bug class person's lifecycle comment
 * documents). `revokedAt` lets receivers stamp `manifest_references.revoked_at`
 * with the ORIGIN's clock.
 */
export interface RevocationPayload {
  id: string;
  entityType: 'resource' | 'agent';
  /** The resource kind when known (post/event/listing/...), else null. */
  resourceType?: string | null;
  reason: 'deleted' | 'cancelled' | 'retracted';
  /** ISO timestamp at the origin. */
  revokedAt: string;
}

/** Build the standard revocation payload (emitters use this, never ad-hoc). */
export function buildRevocationPayload(input: {
  id: string;
  entityType: 'resource' | 'agent';
  resourceType?: string | null;
  reason?: RevocationPayload['reason'];
}): RevocationPayload {
  return {
    id: input.id,
    entityType: input.entityType,
    resourceType: input.resourceType ?? null,
    reason: input.reason ?? 'deleted',
    revokedAt: new Date().toISOString(),
  };
}
