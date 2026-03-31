-- Per-peer shared secrets for federation API authentication.
-- Each peer relationship gets its own credential, enabling independent
-- rotation and revocation without affecting other peer connections.

ALTER TABLE "node_peers" ADD COLUMN IF NOT EXISTS "peer_secret_hash" text;
ALTER TABLE "node_peers" ADD COLUMN IF NOT EXISTS "secret_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "node_peers" ADD COLUMN IF NOT EXISTS "secret_rotated_at" timestamp with time zone;
ALTER TABLE "node_peers" ADD COLUMN IF NOT EXISTS "secret_expires_at" timestamp with time zone;
