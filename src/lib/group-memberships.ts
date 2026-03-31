/**
 * Membership plan normalization and backward-compatibility helpers.
 *
 * Purpose:
 * - Normalize arbitrary metadata payloads into a strict `GroupMembershipPlan[]`.
 * - Enforce consistent defaults and bounds for names, descriptions, and pricing.
 * - Preserve legacy support for `membershipTiers` when plan objects are absent.
 *
 * Key exports:
 * - `normalizeGroupMembershipPlans` for schema-safe conversion of unknown input.
 * - `readGroupMembershipPlans` for metadata-first resolution with legacy fallback.
 *
 * Dependencies:
 * - None (pure data-shaping utility with deterministic behavior).
 */
export type GroupMembershipPlan = {
  id: string;
  name: string;
  description: string;
  amountMonthlyCents: number | null;
  amountYearlyCents: number | null;
  active: boolean;
  perks: string[];
  isDefault: boolean;
  stripePriceIdMonthly?: string;
  stripePriceIdYearly?: string;
};

/** Maximum allowed plan name length to keep labels UI-safe and consistent. */
const MAX_NAME_LENGTH = 80;
/** Maximum allowed description length to prevent oversized metadata payloads. */
const MAX_DESCRIPTION_LENGTH = 300;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asNullableCents(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Negative and fractional cent values are normalized into non-negative integers.
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string") {
    // Strip currency symbols and separators from user-entered values before parsing.
    const stripped = value.replace(/[^0-9.-]/g, "");
    if (!stripped) return null;
    const parsed = Number(stripped);
    if (!Number.isFinite(parsed)) return null;
    // Heuristic: decimal string values below 1000 are treated as dollars, then converted to cents.
    if (Math.abs(parsed) < 1000 && stripped.includes(".")) {
      return Math.max(0, Math.round(parsed * 100));
    }
    return Math.max(0, Math.round(parsed));
  }
  return null;
}

function normalizeId(name: string, fallback: string): string {
  // Slug-like IDs reduce collisions and make debugging metadata easier.
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || fallback;
}

/**
 * Normalizes unknown membership plan input into a validated array of plans.
 *
 * @param {unknown} value - Raw metadata value, usually `metadata.membershipPlans`.
 * @returns {GroupMembershipPlan[]} Normalized and deduplicated membership plans.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * normalizeGroupMembershipPlans([{ name: "Core", amountMonthlyCents: "19.99" }]);
 */
export function normalizeGroupMembershipPlans(value: unknown): GroupMembershipPlan[] {
  const entries = Array.isArray(value) ? value : [];
  const plans: GroupMembershipPlan[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const raw = asRecord(entries[i]);
    // Empty names are treated as invalid plans and dropped.
    const name = asString(raw.name).trim().slice(0, MAX_NAME_LENGTH);
    if (!name) continue;

    const fallbackId = `plan-${i + 1}`;
    const planId = asString(raw.id).trim() || normalizeId(name, fallbackId);
    const perks = asStringArray(raw.perks).map((perk) => perk.trim()).filter(Boolean).slice(0, 20);
    const description = asString(raw.description).trim().slice(0, MAX_DESCRIPTION_LENGTH);

    plans.push({
      id: planId,
      name,
      description,
      amountMonthlyCents: asNullableCents(raw.amountMonthlyCents ?? raw.monthlyPriceCents ?? raw.monthlyCents),
      amountYearlyCents: asNullableCents(raw.amountYearlyCents ?? raw.yearlyPriceCents ?? raw.yearlyCents),
      active: raw.active !== false,
      perks,
      isDefault: Boolean(raw.isDefault),
      stripePriceIdMonthly: asString(raw.stripePriceIdMonthly).trim() || undefined,
      stripePriceIdYearly: asString(raw.stripePriceIdYearly).trim() || undefined,
    });
  }

  if (plans.length === 0) {
    return [];
  }

  const defaultIndex = plans.findIndex((plan) => plan.isDefault);
  if (defaultIndex === -1) {
    // Guarantee exactly one default to simplify checkout and plan-selection flows.
    const firstActive = plans.findIndex((plan) => plan.active);
    plans[firstActive === -1 ? 0 : firstActive].isDefault = true;
  } else {
    plans.forEach((plan, idx) => {
      if (idx !== defaultIndex) plan.isDefault = false;
    });
  }

  const seenIds = new Set<string>();
  return plans.map((plan, idx) => {
    let id = plan.id;
    if (seenIds.has(id)) {
      // Duplicate IDs are rewritten deterministically to avoid collisions.
      id = `${id}-${idx + 1}`;
    }
    seenIds.add(id);
    return { ...plan, id };
  });
}

/**
 * Reads membership plans from group metadata with legacy `membershipTiers` fallback.
 *
 * @param {Record<string, unknown>} metadata - Agent/group metadata object.
 * @returns {GroupMembershipPlan[]} Plan objects ready for frontend consumption.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * readGroupMembershipPlans({ membershipTiers: ["Basic", "Premium"] });
 */
export function readGroupMembershipPlans(metadata: Record<string, unknown>): GroupMembershipPlan[] {
  const fromPlans = normalizeGroupMembershipPlans(metadata.membershipPlans);
  if (fromPlans.length > 0) return fromPlans;

  const tiers = asStringArray(metadata.membershipTiers);
  if (tiers.length === 0) return [];

  return tiers.map((name, idx) => ({
    // Legacy tiers become active plans with null prices to preserve old behavior.
    id: normalizeId(name, `tier-${idx + 1}`),
    name,
    description: "",
    amountMonthlyCents: null,
    amountYearlyCents: null,
    active: true,
    perks: [],
    isDefault: idx === 0,
  }));
}
