-- Add PeerMesh federation identity columns to agents
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS peermesh_handle text,
  ADD COLUMN IF NOT EXISTS peermesh_did text,
  ADD COLUMN IF NOT EXISTS peermesh_public_key text,
  ADD COLUMN IF NOT EXISTS peermesh_manifest_id text,
  ADD COLUMN IF NOT EXISTS peermesh_manifest_url text,
  ADD COLUMN IF NOT EXISTS peermesh_linked_at timestamptz;

-- AT Protocol (Bluesky) identity columns
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS atproto_handle text,
  ADD COLUMN IF NOT EXISTS atproto_did text,
  ADD COLUMN IF NOT EXISTS atproto_linked_at timestamptz;

-- Unique constraints: one PeerMesh identity per agent, one agent per identity
CREATE UNIQUE INDEX IF NOT EXISTS agents_peermesh_handle_idx ON agents (peermesh_handle) WHERE peermesh_handle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_peermesh_manifest_id_idx ON agents (peermesh_manifest_id) WHERE peermesh_manifest_id IS NOT NULL;

-- Unique constraints: one Bluesky identity per agent
CREATE UNIQUE INDEX IF NOT EXISTS agents_atproto_handle_idx ON agents (atproto_handle) WHERE atproto_handle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_atproto_did_idx ON agents (atproto_did) WHERE atproto_did IS NOT NULL;

COMMENT ON COLUMN agents.peermesh_handle IS 'PeerMesh handle (e.g., camalot)';
COMMENT ON COLUMN agents.peermesh_did IS 'Decentralized Identifier from PeerMesh (did:web:...)';
COMMENT ON COLUMN agents.peermesh_public_key IS 'Ed25519 public key multibase from manifest integrity block';
COMMENT ON COLUMN agents.peermesh_manifest_id IS 'UUID of the PeerMesh Universal Manifest';
COMMENT ON COLUMN agents.peermesh_manifest_url IS 'Canonical URL of the live manifest';
COMMENT ON COLUMN agents.peermesh_linked_at IS 'Timestamp when PeerMesh identity was linked';
COMMENT ON COLUMN agents.atproto_handle IS 'AT Protocol handle (e.g., user.bsky.social)';
COMMENT ON COLUMN agents.atproto_did IS 'AT Protocol DID (did:plc:...)';
COMMENT ON COLUMN agents.atproto_linked_at IS 'Timestamp when AT Protocol identity was linked';
