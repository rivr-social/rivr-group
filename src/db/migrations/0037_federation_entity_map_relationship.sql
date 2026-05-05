-- 0042_federation_entity_map_relationship.sql
-- Add a relationship classification to federation_entity_map so resolveViaEntityMap
-- can distinguish:
--   mirrored_remote — local entity is a projection of a remote canonical actor;
--                     writes targeting this local id should forward to the remote.
--                     Used for sovereign-link merges and auto-projected peer agents.
--   local_alias     — local entity is locally canonical and has a known alias on
--                     a remote node (e.g. for inbound aggregation only).
--                     Writes targeting this local id stay local.
--
-- Existing rows: default to mirrored_remote since prior to this migration the
-- only path that inserted entity_map rows was the auto-projection path inside
-- importFederationEvents (resolveLocalEntityId), which always meant
-- "this local id is a projection of a remote canonical."

DO $$ BEGIN
  CREATE TYPE federation_entity_relationship AS ENUM ('mirrored_remote', 'local_alias');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE federation_entity_map
  ADD COLUMN IF NOT EXISTS relationship federation_entity_relationship NOT NULL DEFAULT 'mirrored_remote';

CREATE INDEX IF NOT EXISTS federation_entity_map_relationship_idx
  ON federation_entity_map(relationship);
