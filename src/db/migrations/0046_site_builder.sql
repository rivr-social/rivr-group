-- Site builder (WS-B / B4 + B5): bring the person app's static-site builder to
-- GLOBAL for both first-class users AND groups, plus custom-domain DNS binding.
--
--   site_versions      : full per-owner snapshots of generated site files
--                        (matches the person app's site_versions shape)
--   site_publications  : the current published version + optional custom-domain
--                        binding written via an A7 DNS connector
--
-- Both are home-authority (per-instance) and are NEVER federated. No secrets are
-- stored here: the DNS credential lives only on the `user_connections` lane
-- (encrypted-at-rest via src/lib/crypto/secret-box.ts). Idempotent so it can be
-- applied by hand on environments where the boot migrate chain is blocked.

CREATE TABLE IF NOT EXISTS site_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  commit_message text,
  files_snapshot jsonb NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_versions_agent_idx ON site_versions (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS site_versions_agent_version_idx
  ON site_versions (agent_id, version_number);
CREATE INDEX IF NOT EXISTS site_versions_created_at_idx ON site_versions (created_at);

CREATE TABLE IF NOT EXISTS site_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  published_version_id uuid REFERENCES site_versions(id) ON DELETE SET NULL,
  published_version_number integer,
  theme text,
  custom_domain text,
  domain_provider text,
  domain_status text NOT NULL DEFAULT 'unbound',
  domain_error text,
  published_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_publications_agent_idx
  ON site_publications (agent_id);
-- Partial unique index: at most one owner per bound custom domain; many NULLs ok.
CREATE UNIQUE INDEX IF NOT EXISTS site_publications_domain_idx
  ON site_publications (custom_domain);

COMMENT ON TABLE site_versions IS
  'Site builder version snapshots: full per-owner static-site file maps for lossless rollback. Matches the person app site_versions shape. Home-authority; never federated.';
COMMENT ON TABLE site_publications IS
  'Current published site state per owner agent plus optional custom-domain DNS binding (written via an A7 user_connections DNS connector). No secrets stored here. Home-authority; never federated.';
