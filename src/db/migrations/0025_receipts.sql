-- 0025_receipts.sql
-- Add receipt resource type for marketplace purchase receipts
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'receipt';

-- Add refund verb type for refund ledger entries
ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'refund';
