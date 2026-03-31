/**
 * Shared subscription tier constants for display and gating logic.
 *
 * Tier hierarchy (lowest to highest): basic < host < seller < organizer < steward.
 * Higher tiers inherit all lower-tier entitlements.
 */

import type { MembershipTier } from "@/db/schema";

/** Human-readable display names for each membership tier. */
export const TIER_DISPLAY_NAMES: Record<MembershipTier, string> = {
  basic: "Basic",
  host: "Host",
  seller: "Seller",
  organizer: "Organizer",
  steward: "Steward",
} as const;

/**
 * Maps a feature category to the minimum required tier.
 * Used by UI components to determine which gate to show.
 */
export const FEATURE_TIER_REQUIREMENTS = {
  /** Selling event tickets (paid events). */
  PAID_EVENTS: "host" as MembershipTier,
  /** Selling marketplace listings/offerings with a price. */
  PAID_OFFERINGS: "seller" as MembershipTier,
  /** Selling marketplace listings with a price. */
  PAID_LISTINGS: "seller" as MembershipTier,
} as const;

/** Feature descriptions shown in the subscription gate dialog. */
export const FEATURE_DESCRIPTIONS = {
  PAID_EVENTS:
    "Creating paid ticketed events requires a Host membership or higher.",
  PAID_OFFERINGS:
    "Creating paid offerings requires a Seller membership or higher.",
  PAID_LISTINGS:
    "Creating paid marketplace listings requires a Seller membership or higher.",
} as const;
