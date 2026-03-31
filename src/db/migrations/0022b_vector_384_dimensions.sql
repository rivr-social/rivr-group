-- Resize embedding columns from 1536 to 384 dimensions to match all-MiniLM-L6-v2 model.
-- Drops existing HNSW indices, alters columns, and recreates indices.
-- Existing data is discarded (NULLed) since no embeddings have been generated yet.

-- Drop existing HNSW indices (cannot ALTER column type with index present)
DROP INDEX IF EXISTS agents_embedding_hnsw_idx;
DROP INDEX IF EXISTS resources_embedding_hnsw_idx;

-- Null out any existing data (dimension mismatch would cause cast failure)
UPDATE agents SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE resources SET embedding = NULL WHERE embedding IS NOT NULL;

-- Alter column types from vector(1536) to vector(384)
ALTER TABLE agents ALTER COLUMN embedding TYPE vector(384);
ALTER TABLE resources ALTER COLUMN embedding TYPE vector(384);

-- Recreate HNSW indices for cosine similarity search
CREATE INDEX agents_embedding_hnsw_idx ON agents USING hnsw (embedding vector_cosine_ops);
CREATE INDEX resources_embedding_hnsw_idx ON resources USING hnsw (embedding vector_cosine_ops);
