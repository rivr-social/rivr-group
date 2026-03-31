-- Migration: Add subscription_status and membership_tier enums plus subscriptions table
-- for Stripe billing integration

DO $$ BEGIN
  CREATE TYPE "subscription_status" AS ENUM (
    'active',
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'unpaid',
    'paused'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "membership_tier" AS ENUM (
    'host',
    'seller',
    'organizer',
    'steward'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "status" "subscription_status" NOT NULL,
  "membership_tier" "membership_tier" NOT NULL,
  "current_period_start" timestamp with time zone NOT NULL,
  "current_period_end" timestamp with time zone NOT NULL,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_id_idx" ON "subscriptions" USING btree ("stripe_subscription_id");
CREATE INDEX IF NOT EXISTS "subscriptions_agent_id_idx" ON "subscriptions" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_customer_id_idx" ON "subscriptions" USING btree ("stripe_customer_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" USING btree ("status");
CREATE INDEX IF NOT EXISTS "subscriptions_membership_tier_idx" ON "subscriptions" USING btree ("membership_tier");
CREATE INDEX IF NOT EXISTS "subscriptions_current_period_end_idx" ON "subscriptions" USING btree ("current_period_end");
