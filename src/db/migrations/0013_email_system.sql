-- Email verification tokens (covers email verification + password reset)
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "token_type" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_verification_tokens_token_idx" ON "email_verification_tokens" USING btree ("token");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_agent_id_idx" ON "email_verification_tokens" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_expires_at_idx" ON "email_verification_tokens" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_token_type_idx" ON "email_verification_tokens" USING btree ("token_type");

-- Email audit log (append-only)
CREATE TABLE IF NOT EXISTS "email_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recipient_email" text NOT NULL,
  "recipient_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "subject" text NOT NULL,
  "email_type" text NOT NULL,
  "status" text NOT NULL,
  "message_id" text,
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "email_log_recipient_agent_id_idx" ON "email_log" USING btree ("recipient_agent_id");
CREATE INDEX IF NOT EXISTS "email_log_email_type_idx" ON "email_log" USING btree ("email_type");
CREATE INDEX IF NOT EXISTS "email_log_status_idx" ON "email_log" USING btree ("status");
CREATE INDEX IF NOT EXISTS "email_log_created_at_idx" ON "email_log" USING btree ("created_at");
