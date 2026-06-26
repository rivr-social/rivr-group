/**
 * Outward-facing AI access policy for the group assistant.
 *
 * MANDATORY POLICY (sovereign-group requirement): the group assistant, when it
 * faces a visitor, is ABAC-scoped to that viewer and rate-limited. This module
 * is the single decision point that classifies a caller and resolves their
 * effective scope. It is a PURE function over already-resolved facts (caller
 * tier, the group's federated visitor scope, and whether public chat is on) so
 * the route handler and tests share identical logic.
 *
 * Caller tiers (most → least privileged):
 *   - owner  — the instance OWNER (PRIMARY_AGENT_ID). Never constrained.
 *   - admin  — a group admin. Full-scope, like the owner.
 *   - member — an authenticated group member. Member-scope KG + chat.
 *   - visitor — a federated SSO viewer (rivr_remote_viewer cookie) who is not a
 *     member. Gated by the instance's federated visitor scope (visitor-scope.ts)
 *     and the assistant's `publicChatEnabled` flag.
 *   - anonymous — no session at all. Allowed only when public chat is enabled
 *     AND the visitor policy grants the baseline read capability.
 */

import type { VisitorScope } from "@/lib/federation/visitor-scope";
import { visitorCan } from "@/lib/federation/visitor-scope";

/** Effective knowledge-graph exposure for a given caller tier. */
export type AssistantKgScope = "full" | "member" | "public";

/** Caller privilege tier relative to the group + instance. */
export type AssistantCallerTier =
  | "owner"
  | "admin"
  | "member"
  | "visitor"
  | "anonymous";

/** Inputs needed to decide assistant access. All pre-resolved by the caller. */
export interface AssistantAccessInput {
  tier: AssistantCallerTier;
  /** Whether the assistant exposes itself to non-admin callers at all. */
  publicChatEnabled: boolean;
  /** The instance's resolved federated visitor scope (visitor-scope.ts). */
  visitorScope: VisitorScope;
}

/** Resolved decision for an assistant chat request. */
export interface AssistantAccessDecision {
  allowed: boolean;
  /** Machine-readable denial reason; `null` when allowed. */
  reason:
    | null
    | "public-chat-disabled"
    | "visitors-disabled"
    | "missing-read-capability";
  /** KG exposure the caller is entitled to. */
  kgScope: AssistantKgScope;
  /** Whether the caller bypasses rate limiting (owner/admin self-surface). */
  rateLimitExempt: boolean;
}

/** Tiers that are full-scope and never rate-limited (the self/admin surface). */
const PRIVILEGED_TIERS: ReadonlySet<AssistantCallerTier> = new Set([
  "owner",
  "admin",
]);

/**
 * Decide whether a caller may chat with the group assistant and at what scope.
 *
 * Owners/admins always pass at full scope and bypass rate limiting (their own
 * control surface). Everyone else is an outward-facing caller: members get
 * member scope; visitors/anonymous are gated by `publicChatEnabled` and the
 * federated visitor policy, and always receive only the public KG scope.
 */
export function resolveAssistantAccess(
  input: AssistantAccessInput,
): AssistantAccessDecision {
  const { tier, publicChatEnabled, visitorScope } = input;

  if (PRIVILEGED_TIERS.has(tier)) {
    return {
      allowed: true,
      reason: null,
      kgScope: "full",
      rateLimitExempt: true,
    };
  }

  if (tier === "member") {
    return {
      allowed: true,
      reason: null,
      kgScope: "member",
      rateLimitExempt: false,
    };
  }

  // Outward-facing (visitor / anonymous): public chat must be enabled.
  if (!publicChatEnabled) {
    return {
      allowed: false,
      reason: "public-chat-disabled",
      kgScope: "public",
      rateLimitExempt: false,
    };
  }

  // Federated visitor policy must permit visitors at all.
  if (!visitorScope.enabled) {
    return {
      allowed: false,
      reason: "visitors-disabled",
      kgScope: "public",
      rateLimitExempt: false,
    };
  }

  // The baseline `read` capability is required to converse at all.
  if (!visitorCan(visitorScope, "read")) {
    return {
      allowed: false,
      reason: "missing-read-capability",
      kgScope: "public",
      rateLimitExempt: false,
    };
  }

  return {
    allowed: true,
    reason: null,
    kgScope: "public",
    rateLimitExempt: false,
  };
}
