-- F3 / AUTH-SEC-002: single-use SSO assertion nonces (SSO replay protection).
--
--   sso_nonces : short-TTL dedup store burned atomically by the SSO ACCEPT
--                paths (/api/federation/remote-auth, /api/federation/sso/land)
--                before the rivr_remote_viewer cookie is minted.
--
-- The signed SSO assertion already carries a `nonce` (src/lib/federation/
-- sso-assertion.ts); single-use enforcement is the acceptor's job. The first
-- accept INSERTs (issuer, nonce); any re-presentation collides on the unique
-- index and is rejected. Keyed by (issuer, nonce) so two distinct issuers can
-- never shadow each other's nonces. `expires_at` mirrors the assertion `exp`
-- (<=5 min) so a sweep can prune the table — but the UNIQUE constraint, not
-- the TTL, is what enforces single use inside the validity window.
--
-- Home-authority / per-instance; never federated. Idempotent so it can be
-- applied by hand on environments where the boot migrate chain is blocked.

CREATE TABLE IF NOT EXISTS sso_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  nonce text NOT NULL,
  actor_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Atomic single-use key: INSERT ... ON CONFLICT DO NOTHING burns the nonce.
CREATE UNIQUE INDEX IF NOT EXISTS sso_nonces_issuer_nonce_idx
  ON sso_nonces (issuer, nonce);

-- Supports the TTL prune sweep.
CREATE INDEX IF NOT EXISTS sso_nonces_expires_at_idx
  ON sso_nonces (expires_at);

COMMENT ON TABLE sso_nonces IS
  'Single-use SSO assertion nonces (F3 / AUTH-SEC-002). Burned atomically in the SSO accept paths before minting rivr_remote_viewer; the (issuer, nonce) unique index enforces single use. Home-authority; never federated.';
