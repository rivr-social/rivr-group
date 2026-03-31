-- Migration: promote vouchers to first-class resource type
-- Converts legacy voucher rows that were normalized into skill.

UPDATE resources
SET
  type = 'voucher'::resource_type,
  metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{resourceKind}',
    to_jsonb('voucher'::text),
    true
  ),
  updated_at = now()
WHERE
  deleted_at IS NULL
  AND (
    type = 'voucher'::resource_type
    OR lower(coalesce(metadata->>'resourceKind', '')) = 'voucher'
    OR lower(coalesce(metadata->>'serviceKind', '')) = 'voucher'
    OR lower(coalesce(metadata->>'offerType', '')) = 'voucher'
    OR lower(name) LIKE '%voucher%'
    OR array_to_string(tags, ',') ILIKE '%voucher%'
  )
  AND type <> 'voucher'::resource_type;
