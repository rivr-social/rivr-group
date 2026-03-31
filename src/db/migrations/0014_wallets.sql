-- Migration 0014: Wallet system
-- Adds wallets and wallet_transactions tables for real balance tracking,
-- Stripe-funded deposits, P2P transfers, and ETH payment recording.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "wallet_type" AS ENUM ('personal', 'group');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "wallet_transaction_type" AS ENUM (
    'stripe_deposit',
    'p2p_transfer',
    'marketplace_purchase',
    'marketplace_payout',
    'event_ticket',
    'service_fee',
    'group_deposit',
    'group_withdrawal',
    'group_transfer',
    'refund',
    'thanks',
    'eth_record'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- wallets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "wallets" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"            uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "type"                "wallet_type" NOT NULL DEFAULT 'personal',
  "balance_cents"       integer NOT NULL DEFAULT 0,
  "currency"            text NOT NULL DEFAULT 'usd',
  "eth_address"         text,
  "stripe_customer_id"  text,
  "is_frozen"           boolean NOT NULL DEFAULT false,
  "metadata"            jsonb DEFAULT '{}'::jsonb,
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"          timestamp with time zone DEFAULT now() NOT NULL
);

-- One wallet per type per agent
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_owner_id_type_idx"
  ON "wallets" ("owner_id", "type");

CREATE INDEX IF NOT EXISTS "wallets_owner_id_idx"
  ON "wallets" ("owner_id");

CREATE INDEX IF NOT EXISTS "wallets_eth_address_idx"
  ON "wallets" ("eth_address")
  WHERE "eth_address" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "wallets_stripe_customer_id_idx"
  ON "wallets" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- wallet_transactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type"                      "wallet_transaction_type" NOT NULL,
  "from_wallet_id"            uuid REFERENCES "wallets"("id"),
  "to_wallet_id"              uuid REFERENCES "wallets"("id"),
  "amount_cents"              integer NOT NULL,
  "fee_cents"                 integer NOT NULL DEFAULT 0,
  "currency"                  text NOT NULL DEFAULT 'usd',
  "description"               text,
  "stripe_payment_intent_id"  text,
  "eth_tx_hash"               text,
  "reference_type"            text,
  "reference_id"              uuid,
  "ledger_entry_id"           uuid REFERENCES "ledger"("id"),
  "status"                    text NOT NULL DEFAULT 'completed',
  "metadata"                  jsonb DEFAULT '{}'::jsonb,
  "created_at"                timestamp with time zone DEFAULT now() NOT NULL
);

-- Stripe PI uniqueness (prevents double-credit on webhook replay)
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_stripe_pi_idx"
  ON "wallet_transactions" ("stripe_payment_intent_id")
  WHERE "stripe_payment_intent_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "wallet_transactions_from_wallet_id_idx"
  ON "wallet_transactions" ("from_wallet_id");

CREATE INDEX IF NOT EXISTS "wallet_transactions_to_wallet_id_idx"
  ON "wallet_transactions" ("to_wallet_id");

CREATE INDEX IF NOT EXISTS "wallet_transactions_type_idx"
  ON "wallet_transactions" ("type");

CREATE INDEX IF NOT EXISTS "wallet_transactions_status_idx"
  ON "wallet_transactions" ("status");

CREATE INDEX IF NOT EXISTS "wallet_transactions_created_at_idx"
  ON "wallet_transactions" ("created_at");

CREATE INDEX IF NOT EXISTS "wallet_transactions_reference_idx"
  ON "wallet_transactions" ("reference_type", "reference_id");

-- Check: balance_cents must never go negative (enforced at app level too)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallets_balance_non_negative'
  ) THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative"
      CHECK ("balance_cents" >= 0);
  END IF;
END $$;

-- Check: amount_cents must be positive
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallet_transactions_amount_positive'
  ) THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_amount_positive"
      CHECK ("amount_cents" > 0);
  END IF;
END $$;

-- Check: fee_cents must be non-negative
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallet_transactions_fee_non_negative'
  ) THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_fee_non_negative"
      CHECK ("fee_cents" >= 0);
  END IF;
END $$;
