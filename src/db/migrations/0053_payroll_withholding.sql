-- 0053: Org payroll-withholding reserve lane (ported from global 0071 —
-- docs/active/payroll-withholding-and-payout-schedule-design-2026-08-05.md in
-- the workspace). ALTER TYPE ... ADD VALUE cannot run inside a transaction on
-- older Postgres; apply standalone, by hand, per sovereign DB (spirit + mab —
-- group migrations are MANUAL).
ALTER TYPE "wallet_type" ADD VALUE IF NOT EXISTS 'payroll_withholding';
ALTER TYPE "wallet_transaction_type" ADD VALUE IF NOT EXISTS 'payroll_withholding';
