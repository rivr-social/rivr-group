-- 0039_federated_visitor_access.sql
-- Cross-instance SSO visitor access: owner-configurable visitor policy +
-- append-only visit log for the global→home pre-authenticated handoff
-- consumed at /api/federation/sso/land.
--
-- federated_visitor_settings is single-row-per-instance (mirrors
-- peer_smtp_config). federated_visit_log is append-only (mirrors
-- mcp_provenance_log) and records the referral path of each landing.

CREATE TABLE IF NOT EXISTS federated_visitor_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  allowed_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  session_ttl_minutes integer NOT NULL DEFAULT 30,
  record_visits boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federated_visitor_settings_instance_id_idx
  ON federated_visitor_settings (instance_id);

CREATE TABLE IF NOT EXISTS federated_visit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL,
  visitor_actor_id uuid NOT NULL,
  is_owner boolean NOT NULL DEFAULT false,
  home_base_url text,
  global_issuer_base_url text,
  landing_path text,
  referrer text,
  visitor_name text,
  user_agent text,
  granted_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  auth_method text NOT NULL DEFAULT 'federated-sso',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federated_visit_log_instance_id_idx
  ON federated_visit_log (instance_id);

CREATE INDEX IF NOT EXISTS federated_visit_log_visitor_actor_id_idx
  ON federated_visit_log (visitor_actor_id);

CREATE INDEX IF NOT EXISTS federated_visit_log_created_at_idx
  ON federated_visit_log (created_at);

COMMENT ON TABLE federated_visitor_settings IS
  'Owner-configurable policy for cross-instance SSO visitors (auto-sign-in, scope, ttl).';

COMMENT ON COLUMN federated_visitor_settings.allowed_capabilities IS
  'Extra capabilities granted to visitors beyond the implicit read scope.';

COMMENT ON TABLE federated_visit_log IS
  'Append-only record of cross-instance SSO landings (referral path + granted scope).';
