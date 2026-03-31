-- Add nonce and event_version columns for replay protection and idempotency
ALTER TABLE "federation_events" ADD COLUMN IF NOT EXISTS "nonce" text;
ALTER TABLE "federation_events" ADD COLUMN IF NOT EXISTS "event_version" integer;

-- Unique nonce index prevents duplicate/replayed events
CREATE UNIQUE INDEX IF NOT EXISTS "federation_events_nonce_idx" ON "federation_events" ("nonce");

-- Composite index for version ordering queries per entity
CREATE INDEX IF NOT EXISTS "federation_events_entity_version_idx" ON "federation_events" ("entity_type", "entity_id", "event_version");
