-- x402 paid-access receipts
--
-- One row per settled x402 (HTTP 402 Payment Required) payment that unlocked a
-- resource. RIVR persists its own receipt independent of the facilitator so a
-- settled payment is replay-safe and access can be re-granted without
-- re-charging.
--
-- Deliberately separate from wallet_transactions: x402 settles a single onchain
-- transfer to one payTo and carries no RIVR fee-split or capital accounting.
-- It is an access proof, not a treasury movement.
--
-- The unique index on settlement_tx is the replay-protection key: the same
-- onchain settlement can never unlock a second time.
--
-- Idempotent on purpose (IF NOT EXISTS guards), consistent with the rest of the
-- migration set that sovereign instances apply out of band.

CREATE TABLE IF NOT EXISTS x402_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  payer_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  payer_address text,
  settlement_tx text NOT NULL,
  network text NOT NULL,
  asset text NOT NULL,
  amount_cents integer NOT NULL,
  pay_to text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS x402_receipts_settlement_tx_idx
  ON x402_receipts (settlement_tx);
CREATE INDEX IF NOT EXISTS x402_receipts_resource_id_idx
  ON x402_receipts (resource_id);
CREATE INDEX IF NOT EXISTS x402_receipts_payer_agent_id_idx
  ON x402_receipts (payer_agent_id);
CREATE INDEX IF NOT EXISTS x402_receipts_created_at_idx
  ON x402_receipts (created_at);

COMMENT ON TABLE x402_receipts IS
  'Settled x402 paid-access receipts; one row per onchain settlement that unlocked a resource. Replay-safe via the unique settlement_tx index.';
COMMENT ON COLUMN x402_receipts.settlement_tx IS
  'Onchain settlement transaction hash. UNIQUE — the replay-protection key that blocks a second unlock from the same transfer.';
COMMENT ON COLUMN x402_receipts.payer_agent_id IS
  'Local actor when the payer was an authenticated principal; null for anonymous/peer payers identified only by payer_address.';
