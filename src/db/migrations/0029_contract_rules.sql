-- 0029_contract_rules.sql
-- Add contract_rules table for visual agreement/contract system (Phase 1)
-- Rules define WHEN/THEN/IF patterns that auto-execute via the ledger engine.
-- Actions are stored as a JSONB array supporting chained multi-action responses.
-- Determiners scope how each slot matches at runtime (any, my, the, that, a, all).

CREATE TABLE IF NOT EXISTS contract_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope_id UUID REFERENCES agents(id),

  -- Trigger pattern: WHEN [det] [who] [does what] [det] [what]
  trigger_subject_determiner TEXT,  -- "any" | "the" | "my" | null (specific)
  trigger_subject_id UUID,          -- null = anyone (when det = "any")
  trigger_verb TEXT,
  trigger_object_determiner TEXT,   -- "any" | "my" | "the" | "that" | "a" | "all" | null
  trigger_object_id UUID,

  -- Actions: THEN chain — JSONB array of chained actions
  -- Each: { verb, objectDeterminer?, objectId?, targetDeterminer?, targetId?, delta? }
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Optional condition: IF [det] [who] [does what] [det] [what]
  condition_subject_determiner TEXT,
  condition_subject_id UUID,
  condition_verb TEXT,
  condition_object_determiner TEXT,
  condition_object_id UUID,

  enabled BOOLEAN NOT NULL DEFAULT true,
  fire_count INTEGER NOT NULL DEFAULT 0,
  max_fires INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contract_rules_owner_idx ON contract_rules(owner_id);
CREATE INDEX IF NOT EXISTS contract_rules_enabled_idx ON contract_rules(enabled);
CREATE INDEX IF NOT EXISTS contract_rules_trigger_verb_idx ON contract_rules(trigger_verb);
