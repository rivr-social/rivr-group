-- Migration: Add missing resource types (post, event, group)
-- These were previously mapped to note, shift, document by Codex

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'post';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'event';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'group';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
