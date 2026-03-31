-- Migration 0020: Sync schema with local development DB
-- Adds missing columns, tables, and indexes that were applied out-of-band.

-- ── resource_type enum: add new taxonomy values ──────────────────────
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'resource';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'skill';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'training';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'place';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'venue';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'booking';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── agents: security & auth columns ────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS totp_recovery_codes jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- ── resources: full-text search ────────────────────────────────────
ALTER TABLE resources ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- ── wallets ────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_type AS ENUM ('personal', 'group');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE wallet_transaction_type AS ENUM (
    'stripe_deposit', 'p2p_transfer', 'marketplace_purchase', 'marketplace_payout',
    'event_ticket', 'service_fee', 'group_deposit', 'group_withdrawal',
    'group_transfer', 'refund', 'thanks', 'eth_record'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type wallet_type NOT NULL DEFAULT 'personal',
  balance_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  eth_address text,
  stripe_customer_id text,
  is_frozen boolean NOT NULL DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type wallet_transaction_type NOT NULL,
  from_wallet_id uuid REFERENCES wallets(id),
  to_wallet_id uuid REFERENCES wallets(id),
  amount_cents integer NOT NULL,
  fee_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  description text,
  stripe_payment_intent_id text,
  eth_tx_hash text,
  reference_type text,
  reference_id uuid,
  ledger_entry_id uuid REFERENCES ledger(id),
  status text NOT NULL DEFAULT 'completed',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── audit_log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_id uuid REFERENCES agents(id),
  target_type text,
  target_id uuid,
  ip_address text,
  user_agent text,
  detail jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── email_log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email text NOT NULL,
  recipient_agent_id uuid REFERENCES agents(id),
  subject text NOT NULL,
  email_type text NOT NULL,
  status text NOT NULL,
  message_id text,
  error text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── email_verification_tokens ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token text NOT NULL,
  token_type text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agents_search_vector ON agents USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_resources_search_vector ON resources USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_wallets_owner_id ON wallets(owner_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_from ON wallet_transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_to ON wallet_transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient_email);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_agent ON email_verification_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token ON email_verification_tokens(token);
