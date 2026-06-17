-- 0038_manifest_references.sql
-- Universal Manifest v0.4 reference index for federated discovery (ported from
-- global migrations 0047_manifest_references + 0048_manifest_reference_tiers).
--
-- The table stores canonical origin pointers and disclosed summary metadata for
-- remote objects. The existing federation materializer in `federation.ts` still
-- writes compatibility shadow rows into `resources`; this index records the
-- canonical origin, manifest/status pointers, and disclosed card metadata beside
-- them so sovereign instances participate in reference-mode federation.

CREATE TABLE IF NOT EXISTS manifest_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_node_id uuid NOT NULL REFERENCES nodes(id),
  external_entity_id text NOT NULL,
  local_entity_id uuid,
  entity_type text NOT NULL,
  manifest_url text,
  manifest_id text,
  manifest_version integer,
  manifest_hash text,
  content_hash text,
  canonical_url text,
  status_ref text,
  required_trust_tier integer NOT NULL DEFAULT 0,
  trust_tier integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'tombstoned', 'revoked', 'expired')),
  facet_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_facet_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_federation_event_id uuid REFERENCES federation_events(id),
  last_verified_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS manifest_references_origin_external_type_idx
  ON manifest_references (origin_node_id, external_entity_id, entity_type);

CREATE INDEX IF NOT EXISTS manifest_references_origin_node_idx
  ON manifest_references (origin_node_id);

CREATE INDEX IF NOT EXISTS manifest_references_local_entity_idx
  ON manifest_references (local_entity_id);

CREATE INDEX IF NOT EXISTS manifest_references_entity_type_idx
  ON manifest_references (entity_type);

CREATE INDEX IF NOT EXISTS manifest_references_status_idx
  ON manifest_references (status);

CREATE INDEX IF NOT EXISTS manifest_references_last_seen_idx
  ON manifest_references (last_seen_at);

CREATE INDEX IF NOT EXISTS manifest_references_required_trust_tier_idx
  ON manifest_references (required_trust_tier);

CREATE INDEX IF NOT EXISTS manifest_references_trust_tier_idx
  ON manifest_references (trust_tier);

COMMENT ON TABLE manifest_references IS
  'Lightweight canonical origin pointers for federated Universal Manifest reference-mode discovery.';

COMMENT ON COLUMN manifest_references.facet_summary IS
  'Disclosed card/search metadata only. Do not store full remote object bodies here.';

COMMENT ON COLUMN manifest_references.required_trust_tier IS
  'Minimum trust tier required to safely project the full remote payload.';

COMMENT ON COLUMN manifest_references.trust_tier IS
  'Evaluated trust tier for the projecting peer at the time this reference was written.';

COMMENT ON COLUMN manifest_references.encrypted_facet_summary IS
  'Opaque sealed facets or encrypted disclosure metadata preserved for higher-trust reads.';
