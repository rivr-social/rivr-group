-- Migration: Authority event cache
--
-- Peer-side cache of signed authority events consumed from global (and other peers)
-- via /api/federation/events/import. Stores the latest-seen event per (agent_id, event_type)
-- so the authority guard can quickly answer: "is this home still authoritative for agent X?".
--
-- Event types currently recognized:
--   - credential.updated              : home/global rotated credential material for this agent
--   - authority.revoke                : home for this agent has been revoked (compromised / migrated)
--   - successor.authority.claim       : a new homeBaseUrl has been claimed as authoritative
--   - credential.tempwrite.from-global: global pushed a signed credential temp-write to home
--
-- This is a local projection / cache table. The canonical append-only log lives on global
-- (authority_event_log). Peers enforce revocation by consulting this local cache on
-- session creation and sensitive mutations.

CREATE TABLE IF NOT EXISTS authority_event_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  event_type text NOT NULL,
  home_base_url text NOT NULL,
  home_authority_version integer,
  authority_status text NOT NULL DEFAULT 'active',
  credential_version integer,
  successor_home_base_url text,
  signed_by text NOT NULL,
  signed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One latest-seen row per (agent, event_type). Upsert path uses this.
CREATE UNIQUE INDEX IF NOT EXISTS authority_event_cache_agent_type_idx
  ON authority_event_cache(agent_id, event_type);

-- Guard lookup paths
CREATE INDEX IF NOT EXISTS authority_event_cache_agent_id_idx
  ON authority_event_cache(agent_id);
CREATE INDEX IF NOT EXISTS authority_event_cache_home_base_url_idx
  ON authority_event_cache(home_base_url);
CREATE INDEX IF NOT EXISTS authority_event_cache_authority_status_idx
  ON authority_event_cache(authority_status);
CREATE INDEX IF NOT EXISTS authority_event_cache_received_at_idx
  ON authority_event_cache(received_at);
