-- 0047_reconcile_federation_owner_id_split.sql
-- H2 owner-id split backfill (NON-DESTRUCTIVE, idempotent, NOT auto-applied).
--
-- Root cause: before this change importFederationEvents.resolveLocalEntityId
-- minted a RANDOM UUID for a remote actor, while the federated-viewer projection
-- (ensureLocalActorAgent in actor-projection.ts) keyed the SAME remote actor by
-- its EXTERNAL id (the visitor's own home agent id). The two paths therefore
-- created TWO agent rows for one remote actor — a duplicate that split
-- ownership/attribution and broke "my content" / delete gates. resolveLocalEntityId
-- now keys NEW mappings by the external id so the paths converge going forward;
-- this script reconciles legacy rows already on disk.
--
-- Strategy (safe + review-before-destroy):
--   * Only touches federated STUB agents (metadata shadow / federatedPlaceholder
--     / isProjection). Locally-owned / merged accounts are never moved.
--   * Repoints owned content + the entity-map pointer from the random-id stub
--     onto the external-id agent the projection canonically owns.
--   * Does NOT delete the orphaned random-id stub agents — operators review and
--     remove those separately once content/ledger references are confirmed clear.
--   * Idempotent: once converged (local_entity_id = external_entity_id) the
--     candidate set is empty, so re-running is a no-op.
--
-- Operational note: write-only. Do NOT auto-apply — run by hand after review
-- (this ecosystem applies migrations manually; the chain is idempotent).

-- 1) Repoint resources owned by the diverged random-id stub onto the external-id
--    canonical agent that the viewer projection owns.
WITH split AS (
  SELECT m.origin_node_id,
         m.external_entity_id,
         m.local_entity_id            AS stale_local_id,
         m.external_entity_id::uuid   AS canonical_id
  FROM federation_entity_map m
  JOIN agents canon ON canon.id = m.external_entity_id::uuid
  JOIN agents stub  ON stub.id  = m.local_entity_id
  WHERE m.entity_type = 'agent'
    AND m.external_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND m.local_entity_id <> m.external_entity_id::uuid
    AND (
      stub.metadata->>'shadow' = 'true'
      OR stub.metadata->>'federatedPlaceholder' = 'true'
      OR stub.metadata->>'isProjection' = 'true'
    )
)
UPDATE resources r
SET owner_id   = s.canonical_id,
    updated_at = NOW()
FROM split s
WHERE r.owner_id = s.stale_local_id;

-- 2) Converge the entity-map pointer so future resolveLocalEntityId returns the
--    external id (matching the projection) instead of the legacy random id.
WITH split AS (
  SELECT m.origin_node_id,
         m.external_entity_id
  FROM federation_entity_map m
  JOIN agents canon ON canon.id = m.external_entity_id::uuid
  JOIN agents stub  ON stub.id  = m.local_entity_id
  WHERE m.entity_type = 'agent'
    AND m.external_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND m.local_entity_id <> m.external_entity_id::uuid
    AND (
      stub.metadata->>'shadow' = 'true'
      OR stub.metadata->>'federatedPlaceholder' = 'true'
      OR stub.metadata->>'isProjection' = 'true'
    )
)
UPDATE federation_entity_map m
SET local_entity_id = m.external_entity_id::uuid,
    updated_at      = NOW()
FROM split s
WHERE m.origin_node_id     = s.origin_node_id
  AND m.external_entity_id = s.external_entity_id
  AND m.entity_type        = 'agent';
