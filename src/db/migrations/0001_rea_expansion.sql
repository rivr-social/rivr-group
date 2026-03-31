-- Migration: REA (Resources, Events, Agents) model expansion
-- Expands agent_type, resource_type, and verb_type enums with new values
-- Uses ADD VALUE IF NOT EXISTS for idempotent, safe execution

-- =============================================================================
-- Agent type enum expansion
-- =============================================================================
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'bot';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'org';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'domain';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'ring';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'family';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'guild';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'community';

-- =============================================================================
-- Resource type enum expansion
-- =============================================================================
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'project';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'job';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'shift';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'task';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'asset';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'voucher';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'currency';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'listing';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'proposal';
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'badge';

-- =============================================================================
-- Verb type enum expansion
-- =============================================================================

-- Economic
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'transact';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'buy';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'sell';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'trade';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'gift';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'earn';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'redeem';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'fund';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'pledge';

-- Work
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'work';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'clock_in';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'clock_out';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'produce';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'consume';

-- Governance
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'vote';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'propose';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'approve';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'reject';

-- Structural / Membership
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'join';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'manage';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'own';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'locate';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'follow';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'belong';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'assign';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'invite';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'employ';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'contain';

-- Lifecycle
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'start';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'complete';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'cancel';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'archive';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'publish';

-- Spatial / Temporal
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'attend';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'host';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'schedule';

-- Social
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'endorse';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'mention';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'comment';
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'react';
