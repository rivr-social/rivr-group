-- Migration: Align resources.type with canonical RIVR resource taxonomy
-- Canonical primary types for real-world objects:
-- event, place, venue, resource, skill, voucher, badge, project, job, task, training, booking

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'resource';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'skill';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'training';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'place';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'venue';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'booking';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

WITH typed AS (
  SELECT
    id,
    type::text AS old_type,
    lower(coalesce(metadata->>'resourceKind', '')) AS rk,
    lower(coalesce(metadata->>'entityType', '')) AS entity_type,
    lower(coalesce(metadata->>'listingType', '')) AS listing_type,
    lower(coalesce(metadata->>'offeringType', '')) AS offering_type,
    (lower(coalesce(metadata->>'isVenue', 'false')) = 'true') AS is_venue
  FROM resources
  WHERE deleted_at IS NULL
),
mapped AS (
  SELECT
    id,
    CASE
      WHEN old_type = 'permission_policy' THEN 'permission_policy'
      WHEN old_type = 'post' OR entity_type = 'post' THEN 'post'
      WHEN old_type = 'group' OR entity_type = 'group' THEN 'group'
      WHEN old_type = 'event' OR rk = 'event' OR entity_type = 'event' THEN 'event'
      WHEN old_type = 'project' OR rk = 'project' OR entity_type = 'project' OR old_type = 'dataset' THEN 'project'
      WHEN old_type = 'badge' OR rk = 'badge' THEN 'badge'
      WHEN old_type = 'job' OR rk = 'job' THEN 'job'
      WHEN old_type = 'task' OR rk = 'task' OR old_type = 'shift' OR rk = 'shift' THEN 'task'
      WHEN old_type = 'training' OR rk = 'training' THEN 'training'
      WHEN old_type = 'place' OR rk = 'place' OR entity_type = 'place' THEN 'place'
      WHEN old_type = 'booking' OR rk = 'booking' THEN 'booking'
      WHEN old_type = 'venue' OR rk = 'venue' OR is_venue THEN 'venue'
      WHEN old_type = 'voucher' OR rk = 'voucher' THEN 'voucher'
      WHEN old_type = 'skill'
        OR rk IN ('skill', 'offering', 'service')
        OR offering_type = 'service'
        OR listing_type = 'service'
      THEN 'skill'
      WHEN old_type IN ('document', 'image', 'video', 'audio', 'link', 'note', 'file', 'dataset', 'listing', 'asset')
        OR rk IN ('resource', 'physical', 'asset', 'marketplace-listing', 'product', 'tool', 'item')
        OR listing_type = 'product'
      THEN 'resource'
      ELSE old_type
    END AS new_type
  FROM typed
)
UPDATE resources r
SET
  type = mapped.new_type::resource_type,
  metadata = jsonb_set(
    coalesce(r.metadata, '{}'::jsonb),
    '{resourceKind}',
    to_jsonb(mapped.new_type),
    true
  ),
  updated_at = now()
FROM mapped
WHERE
  r.id = mapped.id
  AND (
    r.type::text <> mapped.new_type
    OR coalesce(r.metadata->>'resourceKind', '') <> mapped.new_type
  );
