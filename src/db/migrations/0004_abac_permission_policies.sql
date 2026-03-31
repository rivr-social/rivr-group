-- Migration: ABAC Permission Policies & Predicate Privacy
-- Adds permission_policy resource type, predicate-level visibility on ledger

-- 1. Add permission_policy to resource_type enum
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'permission_policy';

-- 2. Add visibility and policy_id columns to ledger for predicate privacy
ALTER TABLE ledger
  ADD COLUMN IF NOT EXISTS visibility visibility_level DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS policy_id uuid REFERENCES resources(id);

-- 3. Create indices for predicate privacy queries
CREATE INDEX IF NOT EXISTS ledger_visibility_idx ON ledger (visibility);
CREATE INDEX IF NOT EXISTS ledger_policy_id_idx ON ledger (policy_id);

-- 4. Create a GIN index on resources.metadata for ABAC policy condition lookups
CREATE INDEX IF NOT EXISTS resources_metadata_gin_idx ON resources USING GIN (metadata jsonb_path_ops);
