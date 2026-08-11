/**
 * FEDERATION ENTITY-STATUS CONTRACT — shared-manifest file (canonical: global;
 * edit HERE and sync outward with tools/shared-sync.sh; parity is enforced
 * inside the drift guard).
 *
 * Scope: NAMES + payload shape ONLY, mirroring mutation-contract.ts and
 * revocation-contract.ts. This is the RECONCILIATION half of the delete→revoke
 * lane: revocation-contract.ts covers the PUSH (a home that deletes content
 * emits a retraction), this covers the PULL (a holder of federated projections
 * asks the home "is this still alive?" and retracts what the home says is gone).
 *
 * Why this exists (2026-08-11): the push lane only ever fires for deletes that
 * went through an app action. Deletes that happen out of band — a direct SQL
 * reset, an inbound Google-Calendar cancellation, a delete performed before the
 * revocation lane shipped, a retraction lost to a peer outage — leave the
 * holder with a PERMANENT zombie: a live card on the aggregator whose home
 * returns "not found" when you click it. Event sourcing alone cannot heal that,
 * because the healing event was never written. An authoritative existence probe
 * can, and it is the only mechanism that converges no matter how the content
 * died.
 *
 * The origin answers about its OWN entities only. `not_authoritative` is the
 * honest answer when the row the origin holds is itself a projection of a third
 * instance — a projection may never be retracted on the say-so of a node that
 * is only relaying it.
 */

/** Path every instance serves the authoritative existence probe on. */
export const FEDERATION_ENTITY_STATUS_PATH = '/api/federation/entity-status';

/** Max entities one probe request may carry; senders chunk, receivers reject above it. */
export const ENTITY_STATUS_MAX_BATCH = 200;

/** Entity classes the probe understands (the two federated projection classes). */
export const ENTITY_STATUS_ENTITY_TYPES = ['resource', 'agent'] as const;
export type EntityStatusEntityType = (typeof ENTITY_STATUS_ENTITY_TYPES)[number];

/**
 * What the origin reports about an entity id:
 * - `live`              — row present and not soft-deleted. Keep the projection.
 * - `deleted`           — row present and soft-deleted. RETRACT the projection.
 * - `missing`           — no row at all (hard-deleted, or never existed here).
 *                         RETRACT: the origin is authoritative for its own id
 *                         space, and a projection attributed to it that it has
 *                         never heard of is unbacked either way.
 * - `not_authoritative` — the origin's own row is a federated projection of a
 *                         third instance. Report only; NEVER retract on this.
 */
export const ENTITY_STATUS_STATES = ['live', 'deleted', 'missing', 'not_authoritative'] as const;
export type EntityStatusState = (typeof ENTITY_STATUS_STATES)[number];

/** States that authorize the caller to retract its local projection. */
export const RETRACTABLE_ENTITY_STATUS_STATES = ['deleted', 'missing'] as const;

/** True when the origin's answer authorizes retracting the local projection. */
export function isRetractableEntityStatus(state: string): boolean {
  return (RETRACTABLE_ENTITY_STATUS_STATES as readonly string[]).includes(state);
}

/** One entity the caller wants a verdict on. `id` is the ORIGIN's own id. */
export interface EntityStatusQuery {
  entityType: EntityStatusEntityType;
  id: string;
}

/** Probe request body. */
export interface EntityStatusRequest {
  entities: EntityStatusQuery[];
}

/** One verdict. Echoes the query so callers can match without positional trust. */
export interface EntityStatusResult extends EntityStatusQuery {
  state: EntityStatusState;
  /** Resource kind when known (post/event/listing/...), else null. */
  resourceType?: string | null;
  /** ISO soft-delete timestamp at the origin when `state === 'deleted'`. */
  deletedAt?: string | null;
}

/** Probe response body. */
export interface EntityStatusResponse {
  success: boolean;
  /** Answering node's slug — callers assert it matches the peer they asked. */
  nodeSlug?: string;
  results?: EntityStatusResult[];
  error?: string;
}

/**
 * Both entity classes are uuid-keyed in every repo's schema, and both halves of
 * this lane hand ids straight to a uuid column. A non-uuid id is therefore not
 * "not found" — it is a query that would abort the whole batch with a Postgres
 * cast error, so it is dropped at the boundary instead.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` can be handed to a uuid-typed column. */
export function isEntityStatusId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/** Normalizes/validates a request body into the queries the receiver will answer. */
export function parseEntityStatusRequest(body: unknown): {
  entities: EntityStatusQuery[];
  error?: string;
} {
  if (!body || typeof body !== 'object') {
    return { entities: [], error: 'Request body must be an object' };
  }
  const raw = (body as { entities?: unknown }).entities;
  if (!Array.isArray(raw)) {
    return { entities: [], error: '"entities" must be an array' };
  }
  if (raw.length > ENTITY_STATUS_MAX_BATCH) {
    return {
      entities: [],
      error: `"entities" exceeds ENTITY_STATUS_MAX_BATCH (${ENTITY_STATUS_MAX_BATCH})`,
    };
  }
  const entities: EntityStatusQuery[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entityType = (item as { entityType?: unknown }).entityType;
    const id = (item as { id?: unknown }).id;
    if (!isEntityStatusId(id)) continue;
    if (!(ENTITY_STATUS_ENTITY_TYPES as readonly unknown[]).includes(entityType)) continue;
    const key = `${entityType as string}:${id.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ entityType: entityType as EntityStatusEntityType, id: id.trim() });
  }
  return { entities };
}

/** Origin-pointer metadata keys that mark a row as another instance's entity. */
const ORIGIN_POINTER_METADATA_KEYS = ['originNodeId', 'originBaseUrl', 'homeBaseUrl'] as const;

/** The row shape the classifier needs — uniform across every repo's tables. */
export interface EntityStatusRow {
  id: string;
  deletedAt: Date | string | null;
  metadata: unknown;
  /** The row's `type` column, used when metadata carries no resource kind. */
  type?: string | null;
}

/**
 * True when the row an origin holds is itself a federated projection rather
 * than a locally homed entity.
 *
 * This is the safety rule of the whole lane and it may not fork between repos:
 * an instance that answered `deleted`/`missing` for content it is merely
 * relaying would let one peer's stale mirror retract a third instance's live
 * content.
 *
 * The `externalEntityId` test compares against the row's OWN id on purpose: a
 * home that stamps its own id there is just labelling itself, while a DIFFERENT
 * id means this row mirrors another instance's entity (live examples of both
 * shapes exist on the fleet).
 */
export function isProjectionRow(rowId: string, metadata: unknown, localNodeId: string): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as Record<string, unknown>;
  if (meta.federated === true || meta.federated === 'true') return true;
  if (meta.federatedPlaceholder === true || meta.federatedPlaceholder === 'true') return true;
  const externalEntityId = meta.externalEntityId;
  if (
    typeof externalEntityId === 'string' &&
    externalEntityId.trim() &&
    externalEntityId.trim() !== rowId
  ) {
    return true;
  }
  // An origin pointer at ANOTHER node is the structural tell; our own node id
  // stamped on our own row is not (some emit paths stamp it on local content).
  for (const key of ORIGIN_POINTER_METADATA_KEYS) {
    const value = meta[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (key === 'originNodeId' && value.trim() === localNodeId) continue;
    return true;
  }
  return false;
}

/** Resolves the resource kind an origin reports alongside its verdict. */
export function resolveResourceKind(metadata: unknown, type: string | null | undefined): string | null {
  if (metadata && typeof metadata === 'object') {
    const meta = metadata as Record<string, unknown>;
    const kind = meta.resourceKind ?? meta.entityType;
    if (typeof kind === 'string' && kind.trim()) return kind.trim();
  }
  return typeof type === 'string' && type.trim() ? type : null;
}

/**
 * Classifies one queried entity against the row (if any) the origin holds.
 * A `null` row means the origin has no such entity at all.
 */
export function classifyEntityStatus(
  query: EntityStatusQuery,
  row: EntityStatusRow | null | undefined,
  localNodeId: string,
): EntityStatusResult {
  if (!row) {
    return { ...query, state: 'missing', resourceType: null, deletedAt: null };
  }
  const resourceType = resolveResourceKind(row.metadata, row.type ?? null);
  if (isProjectionRow(row.id, row.metadata, localNodeId)) {
    return { ...query, state: 'not_authoritative', resourceType, deletedAt: null };
  }
  if (row.deletedAt) {
    return {
      ...query,
      state: 'deleted',
      resourceType,
      deletedAt: new Date(row.deletedAt).toISOString(),
    };
  }
  return { ...query, state: 'live', resourceType, deletedAt: null };
}
