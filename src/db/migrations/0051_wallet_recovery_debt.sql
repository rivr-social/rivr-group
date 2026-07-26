-- Allow a wallet balance to carry recovery debt.
--
-- Refund and chargeback recovery debit the wallets that were credited by the
-- original settlement. When a seller has already spent or cashed out those
-- proceeds, the recovered amount exceeds the current balance -- and a full
-- refund ALWAYS exceeds it, because Stripe keeps its processing fee on a
-- refund and that fee is recovered on top of the principal.
--
-- Policy (Cameron, 2026-07-20): the debit is allowed to drive the balance
-- negative and stand as a recorded debt netted from the seller's future sales.
-- `wallets_balance_non_negative` (migration 0014) directly contradicted that
-- policy: recovery raised a check violation, the Stripe webhook returned 500,
-- and the loss was never recovered while Stripe retried the event forever.
--
-- Cash-out remains blocked while a balance is negative: every payout and spend
-- path re-reads the locked balance and requires `balanceCents >= amountCents`,
-- which no negative balance can satisfy.
--
-- Fleet parity: global 0065_wallet_recovery_debt, person 0060_wallet_recovery_debt.

ALTER TABLE "wallets"
  DROP CONSTRAINT IF EXISTS "wallets_balance_non_negative";
