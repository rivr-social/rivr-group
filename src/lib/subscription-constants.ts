/**
 * Shared subscription tier constants for display and gating logic.
 *
 * Capabilities are PARALLEL, not a strict ladder (Host ∥ Seller are peers;
 * Provider has both specialties; Organization adds org-group creation; Steward
 * and Worker are hidden all-capability tiers). See `@/lib/entitlements` for the
 * authoritative capability map.
 */

import type { MembershipTier } from "@/db/schema";

/** Human-readable display names for each membership tier (canonical copy). */
export const TIER_DISPLAY_NAMES: Record<MembershipTier, string> = {
  basic: "Collaborator",
  host: "Host",
  seller: "Seller",
  provider: "Provider",
  organizer: "Organization",
  steward: "Steward",
  worker: "Worker",
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
