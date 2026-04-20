-- Peer outgoing SMTP configuration — ticket #106
--
-- Adds per-instance SMTP settings for peer Rivr instances
-- (person/group/locale/region) so they can send their own transactional
-- notifications (group broadcasts, login notices, billing receipts, etc.)
-- through their own Gmail Workspace / Postmark / custom relay instead of
-- always delegating to the global identity authority.
--
-- Federated-auth email (verification, password-reset, recovery) is NOT
-- affected by this table — those kinds are ALWAYS routed through global
-- by the mailer regardless of peer SMTP status. See src/lib/mailer.ts.
--
-- Security notes:
--   - password_secret_ref stores a REFERENCE to where the credential lives
--     (env var name or Docker secret mount path), NEVER the plaintext
--     password. The actual value is resolved at send time.
--   - The unique index on instance_id enforces one config per instance;
--     upserts are keyed on instance_id so the admin UI saves idempotently.
--
-- Paired with:
--   - src/lib/federation/peer-smtp.ts (config loader + secret resolver)
--   - src/lib/federation/peer-smtp-transport.ts (nodemailer wrapper)
--   - src/app/api/admin/smtp-config/* (admin API surface)

CREATE TABLE IF NOT EXISTS peer_smtp_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 587,
  secure boolean NOT NULL DEFAULT false,
  username text NOT NULL,
  from_address text NOT NULL,
  password_secret_ref text NOT NULL,
  last_test_at timestamptz,
  last_test_status text,
  last_test_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS peer_smtp_config_instance_id_idx
  ON peer_smtp_config (instance_id);

COMMENT ON TABLE peer_smtp_config IS
  'Per-instance outgoing SMTP configuration for peer Rivr instances. Federated-auth email always routes through global regardless of rows here.';
COMMENT ON COLUMN peer_smtp_config.password_secret_ref IS
  'Reference to the credential source — either an env var name (e.g. PEER_SMTP_PASSWORD) or a Docker secret mount path (e.g. /run/secrets/peer_smtp_password). NEVER the plaintext password.';
COMMENT ON COLUMN peer_smtp_config.last_test_status IS
  'Status of the most recent admin-initiated test send: ok | failed | null (never tested).';
