-- Per-group third-party connection credentials (PR1: Google Workspace).
--
-- Adds a per-group OAuth credentials table so a group admin can link the
-- group's own Google Workspace account. Used by the central mailer to
-- send group broadcasts via the group's Gmail account (XOAUTH2) and by
-- future PR2 calendar-sync work.
--
-- Scope contract:
--   - One connection row per (group_id, provider). The unique index
--     enforces upsert semantics in the OAuth callback.
--   - connected_by_user_id records which admin authorized the linkage,
--     for audit and re-auth flows when tokens expire.
--
-- Security notes:
--   - access_token and refresh_token are stored at rest; protect the
--     database accordingly. The mailer resolves them only at send time.
--   - config.smtpEnabled and config.calendarSyncEnabled default to
--     false; an admin must explicitly opt in from the Connections UI.
--
-- Paired with:
--   - src/lib/google/constants.ts
--   - src/lib/google/token.ts
--   - src/app/api/group/[groupId]/connections/google/connect/route.ts
--   - src/app/api/group/[groupId]/connections/google/callback/route.ts
--   - src/app/groups/[id]/settings/connections/page.tsx

CREATE TABLE IF NOT EXISTS group_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  provider text NOT NULL,
  connected_by_user_id uuid NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  token_type text NOT NULL DEFAULT 'Bearer',
  expires_at timestamptz,
  scope text,
  account_email text NOT NULL,
  config jsonb NOT NULL DEFAULT '{"smtpEnabled":false,"calendarSyncEnabled":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS group_connections_group_id_provider_idx
  ON group_connections (group_id, provider);

CREATE INDEX IF NOT EXISTS group_connections_group_id_idx
  ON group_connections (group_id);

COMMENT ON TABLE group_connections IS
  'Per-group third-party OAuth connections (PR1: Google Workspace). One row per (group_id, provider).';
COMMENT ON COLUMN group_connections.connected_by_user_id IS
  'agents.id of the admin who authorized the link. Useful for audit and re-auth flows.';
COMMENT ON COLUMN group_connections.config IS
  'JSON: { calendarId?, fromAddress?, smtpEnabled: bool, calendarSyncEnabled: bool }. Toggles default to false until admin opts in.';
