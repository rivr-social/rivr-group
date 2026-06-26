-- 0041_deliverables_and_outbound_connectors.sql
-- EPIC J3 (deliverables) + J9 (cross-platform reshare lane).
--
-- J3 — Deliverables:
--   A project's jobs are broken into tasks; tasks are grouped into named
--   deliverables (a shippable unit of work). A deliverable is a first-class
--   project-scoped resource so it can carry status, ordering, and its own
--   ledger trail. Tasks reference their deliverable via `metadata.deliverableId`
--   (no schema column needed — the resources table is metadata-driven).
--   `ADD VALUE` is idempotent via IF NOT EXISTS and is referenced by application
--   code at runtime, not within this migration.
--
-- J9 — Cross-platform reshare:
--   Groups can reshare their content (offerings, posts, events) outbound to
--   connected external platforms (Discord, Twitter/X, Slack, etc.). This is a
--   GENERIC outbound lane, distinct from the Google-Workspace-only
--   `group_connections` table (0035) which holds inbound OAuth for mail/calendar.
--   One row per (group_id, platform); credentials are platform-specific JSON.
--
-- Foreign keys:
--   - group_id           -> agents(id) ON DELETE CASCADE
--   - connected_by_user_id -> agents(id) ON DELETE RESTRICT (audit trail)

-- ── J3: deliverable resource type ──────────────────────────────────────────
ALTER TYPE "resource_type" ADD VALUE IF NOT EXISTS 'deliverable';

-- ── J9: generic outbound connector lane ────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_outbound_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform text NOT NULL,
  connected_by_user_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  display_name text,
  -- Platform-specific credentials/config (webhook URL, bot token, channel id,
  -- access token). Resolved only at dispatch time. Defaults to enabled=false so
  -- an admin must explicitly opt the connector in before any outbound post.
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS group_outbound_connectors_group_platform_idx
  ON group_outbound_connectors (group_id, platform);

CREATE INDEX IF NOT EXISTS group_outbound_connectors_group_id_idx
  ON group_outbound_connectors (group_id);

COMMENT ON TABLE group_outbound_connectors IS
  'Per-group outbound social/reshare connectors (EPIC J9). One row per (group_id, platform). Generic lane, distinct from group_connections (Google inbound).';
COMMENT ON COLUMN group_outbound_connectors.credentials IS
  'Platform-specific secrets/config: { webhookUrl?, botToken?, channelId?, accessToken? }. Resolved only at dispatch.';
COMMENT ON COLUMN group_outbound_connectors.config IS
  'JSON: { enabled: bool, ... }. enabled defaults to false until admin opts in.';
