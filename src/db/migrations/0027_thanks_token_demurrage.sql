ALTER TABLE "resources"
  ADD COLUMN IF NOT EXISTS "entered_account_at" timestamptz;

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "hidden_burn_remainder" double precision NOT NULL DEFAULT 0;

UPDATE "resources"
SET "entered_account_at" = COALESCE(
  NULLIF(("metadata"->>'lastTransferredAt')::timestamptz, NULL),
  NULLIF(("metadata"->>'mintedAt')::timestamptz, NULL),
  "created_at"
)
WHERE "type" = 'thanks_token'
  AND "entered_account_at" IS NULL;

CREATE INDEX IF NOT EXISTS "resources_type_owner_entered_account_idx"
  ON "resources" ("type", "owner_id", "entered_account_at");
