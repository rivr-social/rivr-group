-- Add JSONB GIN indexes for metadata-heavy access patterns
CREATE INDEX IF NOT EXISTS agents_metadata_gin_idx
  ON agents
  USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS ledger_metadata_gin_idx
  ON ledger
  USING GIN (metadata jsonb_path_ops);
