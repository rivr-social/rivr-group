-- Migration: Add Provider + Worker membership tiers to the membership_tier enum.
--   provider = Host + Seller + Collaborator capabilities (sell tickets AND
--              offerings, claim jobs) but NOT organization-group creation.
--   worker   = hidden all-capability tier tied to a hidden share-class group
--              (org-granted, like steward).
-- Idempotent so it can be applied by hand where the boot migrate chain is blocked.
ALTER TYPE "membership_tier" ADD VALUE IF NOT EXISTS 'provider';
ALTER TYPE "membership_tier" ADD VALUE IF NOT EXISTS 'worker';
