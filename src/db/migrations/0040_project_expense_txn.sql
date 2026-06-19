-- 0040_project_expense_txn.sql
-- First-class project expenses.
--
-- Projects fund their work by spending from their treasury wallet (see 0039).
-- An expense is a debit out of the project treasury to an external payee — it is
-- not a transfer to another internal wallet — so it needs its own transaction
-- type for ledger filtering and UI labeling. `ADD VALUE` is committed with the
-- migration; the new label is only referenced by application code at runtime.
ALTER TYPE "wallet_transaction_type" ADD VALUE IF NOT EXISTS 'project_expense';
