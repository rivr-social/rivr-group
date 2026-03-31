-- Migration: ReBAC Permissions
-- Adds visibility controls, structured permission columns on ledger,
-- group password protection, and new permission verbs.
-- Designed for federation: permissions are ledger entries (tuples) that
-- can replicate across instances.

-- =============================================================================
-- Visibility level enum
-- =============================================================================
DO $$ BEGIN
  CREATE TYPE visibility_level AS ENUM ('public', 'locale', 'members', 'private');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- Agents table: add visibility and group password
-- =============================================================================
ALTER TABLE agents ADD COLUMN IF NOT EXISTS visibility visibility_level DEFAULT 'locale';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS group_password_hash text;

CREATE INDEX IF NOT EXISTS agents_visibility_idx ON agents (visibility);

-- =============================================================================
-- Resources table: add visibility, replace boolean is_public
-- =============================================================================
ALTER TABLE resources ADD COLUMN IF NOT EXISTS visibility visibility_level DEFAULT 'members';

-- Migrate existing is_public data to visibility enum
UPDATE resources SET visibility = 'public' WHERE is_public = true AND visibility = 'members';

-- Drop is_public after migration (keep for now for backwards compat)
-- ALTER TABLE resources DROP COLUMN IF EXISTS is_public;

CREATE INDEX IF NOT EXISTS resources_visibility_idx ON resources (visibility);

-- =============================================================================
-- Ledger table: add structured permission columns
-- =============================================================================
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS role text;

-- Partial indexes for active permission queries (most common pattern)
CREATE INDEX IF NOT EXISTS ledger_active_subject_verb_idx
  ON ledger (subject_id, verb, is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS ledger_active_object_verb_idx
  ON ledger (object_id, verb, is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS ledger_active_role_idx
  ON ledger (subject_id, object_id, role) WHERE is_active = true AND role IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_expires_idx
  ON ledger (expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- New permission verb types
-- =============================================================================
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'grant';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'revoke';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'rent';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'use';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'leave';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'request';
