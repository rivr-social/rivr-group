-- Migration: add the nodes columns that schema.ts declares but no migration created.
--
-- Ported from global 0045_nodes_instance_columns.sql. On the live sovereign
-- databases these were applied out-of-band, so this is a no-op there; it exists
-- so a FRESH instance (and CI) builds the same schema the code expects.
-- Surfaced by the migration-journal repair: person's from-scratch build failed
-- on `column "instance_type" does not exist`.

DO $$ BEGIN
  CREATE TYPE instance_type AS ENUM ('global', 'person', 'group', 'locale', 'region');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE migration_status AS ENUM ('active', 'migrating_out', 'migrating_in', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS instance_type instance_type DEFAULT 'global';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS primary_agent_id uuid REFERENCES agents(id);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS storage_namespace text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '[]';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS health_check_url text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_health_check timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS event_sequence bigint DEFAULT 0;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS migration_status migration_status DEFAULT 'active';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS fee_wallet_address text;

CREATE INDEX IF NOT EXISTS idx_nodes_instance_type ON nodes(instance_type);
CREATE INDEX IF NOT EXISTS idx_nodes_primary_agent_id ON nodes(primary_agent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_migration_status ON nodes(migration_status);
