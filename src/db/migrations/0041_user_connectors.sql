-- Generic per-agent connector credentials (full provider catalog).
--
-- Adds the `user_connectors` table that backs the unified Connectors settings
-- surface, mirroring the global app's table of the same name for cross-instance
-- parity. Where `group_connections` (0035) is Google-Workspace-specific, this
-- table is provider-agnostic and stores credentials for any provider in
-- `src/lib/connectors/catalog.ts` — Google Drive/Calendar/Gmail, Notion,
-- Telegram, WhatsApp, Signal, Slack, Facebook, Instagram, Substack, Luma, X.
--
-- Subject model:
--   - `user_agent_id` is the agent that owns the connection. It may be a person
--     OR a group agent. For group targets, the `/api/connectors` route
--     authorizes writes with a group-admin check (`isGroupAdmin`).
--
-- Scope contract:
--   - One row per (user_agent_id, provider): the unique index enforces upsert
--     semantics so a re-save updates the existing row instead of duplicating.
--
-- Foreign keys:
--   - user_agent_id -> agents(id) ON DELETE CASCADE
--     A connection is meaningless without its owning agent; deleting the agent
--     cleans up its credential rows.
--
-- Sync backends (no background sync loop is created by this migration):
--   - Messenger-class providers (telegram, whatsapp, signal, slack, facebook,
--     instagram) are intended to sync via mautrix bridges on the shared
--     Matrix/Synapse infra, NOT bespoke per-provider polling.
--   - Non-messenger providers (Google Drive/Calendar/Gmail, Notion, Substack,
--     Luma, X) use direct API/OAuth.
--
-- Security notes:
--   - access_token and refresh_token are stored at rest; protect the database
--     accordingly. The API never returns stored credentials to clients.
--
-- Paired with:
--   - src/lib/connectors/catalog.ts
--   - src/app/api/connectors/route.ts
--   - src/components/connectors-settings-panel.tsx
--   - src/db/schema.ts (userConnectors)

CREATE TABLE IF NOT EXISTS user_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_email text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scope text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_connectors_user_provider_idx
  ON user_connectors (user_agent_id, provider);

COMMENT ON TABLE user_connectors IS
  'Generic per-agent connector credentials for the full provider catalog. One row per (user_agent_id, provider). Group targets are gated by group-admin checks in /api/connectors.';
COMMENT ON COLUMN user_connectors.user_agent_id IS
  'agents.id of the owning agent (person or group).';
COMMENT ON COLUMN user_connectors.metadata IS
  'JSON connector metadata, e.g. { connectionType: "credential" }.';
