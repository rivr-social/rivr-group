-- Add connect_payout to wallet_transaction_type enum for Stripe Connect payouts
ALTER TYPE wallet_transaction_type ADD VALUE IF NOT EXISTS 'connect_payout';
