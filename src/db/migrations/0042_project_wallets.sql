-- 0039_project_wallets.sql
-- First-class project treasury wallets (Option A).
--
-- A project is a `resources` row (type = 'project') owned by a group/org agent.
-- Projects are not agents, so they could not previously own a wallet (wallets
-- keyed only on owner_id + type). This migration binds a wallet to a project
-- resource via `resource_id` while keeping `owner_id` pointing at the owning
-- group/org agent (preserving payout authority and the settlement-cascade
-- lineage). Offering revenue tagged with a projectId settles into this wallet,
-- and the project's distribution config cascades a share up the parent lineage.

-- New wallet type. `ADD VALUE` is committed with the migration transaction; the
-- value is only referenced by application code at runtime, never in this file,
-- so there is no in-transaction use of the new label.
ALTER TYPE "wallet_type" ADD VALUE IF NOT EXISTS 'project';--> statement-breakpoint

-- Bind a wallet to a project resource. ON DELETE CASCADE so deleting a project
-- removes its treasury wallet (and, via existing FKs, its capital entries).
ALTER TABLE "wallets" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_resource_id_resources_id_fk"
  FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The historical unique (owner_id, type) only describes owner-scoped wallets
-- (personal / group). Re-scope it to rows without a resource binding so a
-- project wallet never collides with its owner's group wallet.
DROP INDEX IF EXISTS "wallets_owner_id_type_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_owner_id_type_idx"
  ON "wallets" ("owner_id", "type")
  WHERE "resource_id" IS NULL;--> statement-breakpoint

-- Exactly one treasury wallet per project resource.
CREATE UNIQUE INDEX "wallets_resource_id_unique_idx"
  ON "wallets" ("resource_id")
  WHERE "resource_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "wallets_resource_id_idx" ON "wallets" ("resource_id");
