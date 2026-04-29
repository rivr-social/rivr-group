-- External-sync sidecar + cron state for PR2 (Google Calendar two-way sync).
--
-- resource_external_sync
--   Pairs a Rivr resource (currently: event resources) with its counterpart
--   on a third-party provider. The sidecar pattern keeps `resources` clean
--   of provider columns and extends naturally to additional providers.
--   One row per (resource_id, provider).
--
--   Columns:
--     - external_id           : provider's stable id for the paired record
--                               (e.g. Google Calendar event id).
--     - external_calendar_id  : provider container id this record lives in
--                               (e.g. Google calendar id).
--     - external_etag         : optimistic-concurrency token from the
--                               provider; sent back as `If-Match` on patch.
--     - external_updated      : provider-side `updated` timestamp; used for
--                               last-write-wins comparisons.
--     - provenance            : 'rivr_outbound' | 'google_inbound' — which
--                               side wrote the most recent state. Together
--                               with external_etag, used for echo
--                               suppression on inbound polls.
--     - synced_at             : when this row was last successfully synced.
--
--   Indices:
--     - unique (resource_id, provider) for upsert semantics.
--     - (provider, external_calendar_id, external_id) for inbound dedupe.
--
--   Foreign keys:
--     - resource_id -> resources(id) ON DELETE CASCADE — sidecar is
--       meaningless without its parent resource.
--
-- cron_state_google_calendar
--   Persists the Google Calendar incremental syncToken (and
--   last_synced_at) between cron polls so we can ask Google for an
--   incremental change set instead of refetching the full window.
--   One row per (connection_id, calendar_id).
--
--   Foreign keys:
--     - connection_id -> group_connections(id) ON DELETE CASCADE —
--       disconnecting the Google account also drops its sync cursor.
--
-- Paired with:
--   - src/db/schema.ts (resourceExternalSync, cronStateGoogleCalendar)
--   - src/lib/google/calendar.ts
--   - src/lib/google/calendar-sync.ts
--   - src/app/api/cron/google-calendar-sync/route.ts

CREATE TABLE IF NOT EXISTS resource_external_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  external_calendar_id text NOT NULL,
  external_etag text,
  external_updated timestamptz,
  provenance text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_external_sync_resource_provider_idx
  ON resource_external_sync (resource_id, provider);

CREATE INDEX IF NOT EXISTS resource_external_sync_lookup_idx
  ON resource_external_sync (provider, external_calendar_id, external_id);

COMMENT ON TABLE resource_external_sync IS
  'Sidecar pairing a Rivr resource with its external counterpart (PR2: Google Calendar). One row per (resource_id, provider).';
COMMENT ON COLUMN resource_external_sync.provenance IS
  'Which side wrote the most recent state: rivr_outbound | google_inbound. Used with external_etag for echo suppression on inbound polls.';
COMMENT ON COLUMN resource_external_sync.external_etag IS
  'Optimistic-concurrency token from the provider; sent back as If-Match on patch. Also used to detect echoes.';

CREATE TABLE IF NOT EXISTS cron_state_google_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES group_connections(id) ON DELETE CASCADE,
  calendar_id text NOT NULL,
  sync_token text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cron_state_google_calendar_connection_calendar_idx
  ON cron_state_google_calendar (connection_id, calendar_id);

COMMENT ON TABLE cron_state_google_calendar IS
  'Per-(connection, calendar) sync cursor for Google Calendar inbound polling. Stores syncToken (preferred) and last_synced_at (fallback for updatedMin).';
