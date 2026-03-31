-- Migration: Add persona support (parent_agent_id column on agents table)
-- Personas are agents with a parent_agent_id linking them to a parent account.
-- They share the parent's wallet but own their own content.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agents_parent_agent_id_idx ON agents(parent_agent_id);
