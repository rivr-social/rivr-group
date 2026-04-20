-- Link preview / OpenGraph unfurl cache — ticket #15 (Wave 4 port #107)
--
-- Backs POST /api/link-preview. When a user pastes a URL into the post composer
-- (or any other surface that wants rich unfurling), the route hashes the URL,
-- checks this cache for a fresh row, and either returns the cached preview or
-- fetches fresh OpenGraph data from the external site, writing the result back
-- here. Internal RIVR subspace URLs (e.g. /rings/<id>, /groups/<id>) are
-- short-circuited before this cache is consulted and are not written here.
--
-- Security notes:
--   - fetches are validated against an SSRF guard (see src/lib/link-preview.ts)
--     before any row is written.
--   - `fetch_status` distinguishes successful fetches ('ok') from errors and
--     unsupported URLs so we can negatively cache and avoid hammering broken
--     targets.
--
-- Eviction strategy: `fetched_at + ttl_seconds` drives freshness; a periodic
-- GC job can prune rows older than `fetched_at + ttl_seconds` using the
-- `link_previews_fetched_at_idx` index.
--
-- Paired with the `resources.embeds` column added below, which stores the
-- per-post list of attached link/video/internal embeds surfaced in the feed.

CREATE TABLE IF NOT EXISTS link_previews (
  url_hash text PRIMARY KEY,
  url text NOT NULL,
  og_title text,
  og_description text,
  og_image text,
  og_site_name text,
  og_type text,
  favicon text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  ttl_seconds integer NOT NULL DEFAULT 86400,
  fetch_status text NOT NULL,
  fetch_error text
);

CREATE INDEX IF NOT EXISTS link_previews_fetched_at_idx ON link_previews (fetched_at);
CREATE INDEX IF NOT EXISTS link_previews_fetch_status_idx ON link_previews (fetch_status);

COMMENT ON TABLE link_previews IS
  'OpenGraph / unfurl cache for external URLs pasted into RIVR surfaces. Keyed by sha-256 of the normalized URL.';
COMMENT ON COLUMN link_previews.fetch_status IS
  'One of: ok | error | unsupported. error rows are negatively cached for the ttl.';
COMMENT ON COLUMN link_previews.ttl_seconds IS
  'Freshness window in seconds. Default 24 hours; callers may override per-URL via the link-preview route.';

-- Per-post embed attachment list.
-- Shape: Embed[] where each Embed is
--   { url: string,
--     kind: 'link' | 'internal' | 'video' | 'image',
--     ogTitle?: string,
--     ogDescription?: string,
--     ogImage?: string,
--     siteName?: string }
-- Kept alongside the polymorphic resources table so posts (and any other
-- resource that accepts embeds in the future) can render rich preview cards
-- without an extra join. Populated by the post composer before submit.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS embeds jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN resources.embeds IS
  'Rich link/unfurl embeds attached to this resource (typically posts). Array of Embed objects; see src/lib/link-preview.ts.';
