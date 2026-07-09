/**
 * Membership CAPABILITIES (2026-07-09).
 *
 * RIVR subscription tiers grant PARALLEL capabilities, not a strict linear
 * hierarchy: Host and Seller are peers — each adds ONE specialty on top of
 * Collaborator, and neither includes the other's. Only Organization has both.
 *
 *   Collaborator (basic)  → claim badges + take jobs in projects
 *   Host                  → Collaborator + create priced event tickets
 *   Seller                → Collaborator + offer paid products/services
 *   Provider              → Host + Seller + Collaborator (tickets AND offerings,
 *                           but NOT organization creation)
 *   Organization (organizer) → all of the above + create organization-type groups
 *   Steward               → ALL capabilities (hidden; tied to a hidden share class)
 *   Worker                → ALL capabilities (hidden; tied to a hidden share class)
 *
 * This replaces ordinal `hasEntitlement(tier)` comparisons for these gates: a
 * Seller must NOT pass the ticket gate, and a Host must NOT pass the offering
 * gate. Community / family / ring groups are free for any signed-in user (no
 * capability required).
 *
 * PURE + client-safe: this module must NOT import server-only code (db, Stripe,
 * billing). The subscription-resolving `hasCapability` lives in the server-only
 * `@/lib/entitlements-server` so client components can import the pure helpers
 * (`tierHasCapability`, `isOrganizationGroupType`) without pulling `db` into the
 * client bundle.
 */
import type { MembershipTier } from "@/db/schema";

export type Capability =
  | "claim_badges_jobs"
  | "sell_tickets"
  | "sell_offerings"
  | "create_org_group";

/** The full capability set (Organization / Steward / Worker). */
const ALL_CAPABILITIES: readonly Capability[] = [
  "claim_badges_jobs",
  "sell_tickets",
  "sell_offerings",
  "create_org_group",
];

/** Capabilities granted by each tier (parallel model — Host ∥ Seller). */
export const TIER_CAPABILITIES: Record<MembershipTier, ReadonlySet<Capability>> = {
  basic: new Set<Capability>(["claim_badges_jobs"]),
  host: new Set<Capability>(["claim_badges_jobs", "sell_tickets"]),
  seller: new Set<Capability>(["claim_badges_jobs", "sell_offerings"]),
  provider: new Set<Capability>(["claim_badges_jobs", "sell_tickets", "sell_offerings"]),
  organizer: new Set<Capability>(ALL_CAPABILITIES),
  steward: new Set<Capability>(ALL_CAPABILITIES),
  worker: new Set<Capability>(ALL_CAPABILITIES),
};

/** The lowest single tier that grants a capability — used for upgrade copy. */
export const CAPABILITY_ENTRY_TIER: Record<Capability, MembershipTier> = {
  claim_badges_jobs: "basic",
  sell_tickets: "host",
  sell_offerings: "seller",
  create_org_group: "organizer",
};

/** Human tier name for upgrade prompts. */
export const TIER_UPGRADE_LABEL: Record<MembershipTier, string> = {
  basic: "Collaborator",
  host: "Host",
  seller: "Seller",
  provider: "Provider",
  organizer: "Organization",
  steward: "Steward",
  worker: "Worker",
};

/** Pure check: does a tier grant a capability? */
export function tierHasCapability(tier: MembershipTier, capability: Capability): boolean {
  return TIER_CAPABILITIES[tier]?.has(capability) ?? false;
}

/** Whether a requested group subtype is organization-grade (gated). */
export function isOrganizationGroupType(groupType: string | null | undefined): boolean {
  const t = (groupType ?? "").trim().toLowerCase();
  return t === "organization" || t === "org";
}
