/**
 * Server-only entitlement resolution.
 *
 * Bridges the PURE capability map (`@/lib/entitlements`) to the caller's ACTIVE
 * subscription. Kept in a SEPARATE server module because it imports
 * `getActiveSubscription` (→ `db`), which must never reach a client bundle. Client
 * components import the pure helpers from `@/lib/entitlements`; server actions
 * import `hasCapability` from here.
 */
import { getActiveSubscription } from "@/lib/billing";
import { tierHasCapability, type Capability } from "@/lib/entitlements";

/**
 * Whether an agent's ACTIVE subscription grants `capability`. Returns false for
 * agents with no active subscription.
 */
export async function hasCapability(agentId: string, capability: Capability): Promise<boolean> {
  const sub = await getActiveSubscription(agentId);
  if (!sub) return false;
  return tierHasCapability(sub.membershipTier, capability);
}
