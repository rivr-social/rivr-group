-- Migration: Add the Basic membership tier to the subscriptions enum

ALTER TYPE "membership_tier" ADD VALUE IF NOT EXISTS 'basic';
