-- Local location search index backed by Overture datasets.
-- Used by /api/locations/suggest for in-app create/edit autofill.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS overture_places (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  source text NOT NULL DEFAULT 'overture',
  name text NOT NULL,
  display_name text NOT NULL,
  category text,
  country_code text,
  admin_region text,
  locality text,
  street text,
  house_number text,
  postcode text,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  location geometry(Point, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(lon, lat), 4326)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS overture_places_name_trgm_idx
  ON overture_places USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS overture_places_display_name_trgm_idx
  ON overture_places USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS overture_places_locality_idx
  ON overture_places (locality);

CREATE INDEX IF NOT EXISTS overture_places_source_idx
  ON overture_places (source, source_id);

CREATE INDEX IF NOT EXISTS overture_places_location_gist_idx
  ON overture_places USING gist (location);

