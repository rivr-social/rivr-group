-- Enable PostGIS extension for geographic/spatial data
CREATE EXTENSION IF NOT EXISTS postgis;

-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extensions are installed
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'postgis'
  ) THEN
    RAISE EXCEPTION 'PostGIS extension failed to install';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension failed to install';
  END IF;
END $$;

-- Create custom aggregate function for vector averaging (useful for semantic search)
CREATE OR REPLACE FUNCTION vector_avg(vector[])
RETURNS vector AS $$
  SELECT CASE
    WHEN array_length($1, 1) > 0
    THEN (
      SELECT array_agg(avg_val)::real[]::vector
      FROM (
        SELECT avg(val) as avg_val
        FROM unnest($1) WITH ORDINALITY t(vec, ord)
        CROSS JOIN LATERAL unnest(vec::real[]) WITH ORDINALITY u(val, idx)
        GROUP BY idx
        ORDER BY idx
      ) sub
    )
    ELSE NULL
  END
$$ LANGUAGE SQL IMMUTABLE STRICT;

-- Comment on extensions for documentation
COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';
COMMENT ON EXTENSION vector IS 'pgvector extension for vector similarity search using embeddings';
