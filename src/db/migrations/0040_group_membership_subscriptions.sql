-- Group membership subscriptions
--
-- A member's recurring subscription to a sovereign group's own membership plan
-- (distinct from the cooperative RIVR membership tiers in `subscriptions`).
--
-- Settlement rails:
--   * 'connect'          — destination charge to the group's onboarded Stripe
--                          Connect account; RIVR keeps a per-member platform fee
--                          via application_fee_percent. Group is paid directly.
--   * 'platform_capital' — fallback when the group has not completed Connect
--                          onboarding; RIVR collects the full charge and owes
--                          the group, settled internally via `capital_entries`.
--
-- Idempotent on purpose: sovereign instances apply these migrations out of band
-- (the drizzle journal is empty on those trees), so IF NOT EXISTS guards keep
-- re-application safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_subscription_settlement_rail') THEN
    CREATE TYPE group_subscription_settlement_rail AS ENUM ('connect', 'platform_capital');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS group_membership_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_price_id text NOT NULL,
  status subscription_status NOT NULL,
  settlement_rail group_subscription_settlement_rail NOT NULL DEFAULT 'platform_capital',
  stripe_connect_account_id text,
  application_fee_cents integer NOT NULL DEFAULT 0,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS group_membership_subscriptions_stripe_subscription_id_idx
  ON group_membership_subscriptions (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS group_membership_subscriptions_agent_id_idx
  ON group_membership_subscriptions (agent_id);
CREATE INDEX IF NOT EXISTS group_membership_subscriptions_group_id_idx
  ON group_membership_subscriptions (group_id);
CREATE INDEX IF NOT EXISTS group_membership_subscriptions_agent_group_idx
  ON group_membership_subscriptions (agent_id, group_id);
CREATE INDEX IF NOT EXISTS group_membership_subscriptions_status_idx
  ON group_membership_subscriptions (status);
CREATE INDEX IF NOT EXISTS group_membership_subscriptions_current_period_end_idx
  ON group_membership_subscriptions (current_period_end);

COMMENT ON TABLE group_membership_subscriptions IS
  'Recurring member subscriptions to a sovereign group''s own membership plan; settled via Connect destination charge or platform-capital fallback.';
COMMENT ON COLUMN group_membership_subscriptions.settlement_rail IS
  '''connect'' = destination charge to the group''s Connect account (RIVR keeps application_fee_cents); ''platform_capital'' = RIVR collects and owes the group via capital_entries.';
COMMENT ON COLUMN group_membership_subscriptions.application_fee_cents IS
  'RIVR per-member platform fee retained from each charge, in cents.';
