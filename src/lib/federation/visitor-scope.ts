// src/lib/federation/visitor-scope.ts
//
// Capability model + owner-policy resolver for cross-instance SSO visitors.
//
// A federated visitor is a remote actor who landed via the global→home SSO
// handoff (/api/federation/sso/land) and holds a `rivr_remote_viewer` cookie
// rather than a local NextAuth session. By default they get a read-only
// scope; the instance owner can widen that in /settings/visitor-access.
//
// The instance OWNER (PRIMARY_AGENT_ID) is never constrained by this scope —
// when they land via SSO they receive a full session. This module only
// governs NON-owner visitors.

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { federatedVisitorSettings } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";

/** Capabilities a federated visitor may be granted. */
export const VISITOR_CAPABILITIES = [
  "read",
  "react",
  "comment",
  "rsvp",
  "message",
] as const;

export type VisitorCapability = (typeof VISITOR_CAPABILITIES)[number];

/**
 * Baseline capability every authenticated visitor implicitly holds. Browsing
 * is the entire point of auto-sign-in, so `read` is never gated by settings.
 */
export const BASELINE_VISITOR_CAPABILITY: VisitorCapability = "read";

/** Default session lifetime for a visitor cookie when no row exists. */
export const DEFAULT_VISITOR_TTL_MINUTES = 30;

/** Resolved, effective visitor policy for this instance. */
export interface VisitorScope {
  /** Whether non-owner visitors are auto-signed-in at all. */
  enabled: boolean;
  /** Effective capabilities, always including the baseline `read`. */
  capabilities: VisitorCapability[];
  /** Cookie lifetime in minutes. */
  ttlMinutes: number;
  /** Whether landings should be appended to federated_visit_log. */
  recordVisits: boolean;
}

/** Safe default policy used when no settings row exists for this instance. */
export function defaultVisitorScope(): VisitorScope {
  return {
    enabled: true,
    capabilities: [BASELINE_VISITOR_CAPABILITY],
    ttlMinutes: DEFAULT_VISITOR_TTL_MINUTES,
    recordVisits: true,
  };
}

/** Narrow arbitrary strings to known {@link VisitorCapability} values. */
export function sanitizeCapabilities(raw: unknown): VisitorCapability[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<VisitorCapability>();
  for (const value of raw) {
    if (
      typeof value === "string" &&
      (VISITOR_CAPABILITIES as readonly string[]).includes(value) &&
      value !== BASELINE_VISITOR_CAPABILITY
    ) {
      seen.add(value as VisitorCapability);
    }
  }
  return Array.from(seen);
}

/**
 * Resolve the effective visitor policy for this instance from
 * `federated_visitor_settings`. Falls back to {@link defaultVisitorScope}
 * when no row exists.
 */
export async function resolveVisitorScope(): Promise<VisitorScope> {
  const { instanceId } = getInstanceConfig();
  let row: typeof federatedVisitorSettings.$inferSelect | undefined;
  try {
    [row] = await db
      .select()
      .from(federatedVisitorSettings)
      .where(eq(federatedVisitorSettings.instanceId, instanceId))
      .limit(1);
  } catch {
    // Table may not exist yet (pre-migration) — degrade to the safe default
    // rather than failing the landing/session resolution.
    return defaultVisitorScope();
  }

  if (!row) return defaultVisitorScope();

  const extras = sanitizeCapabilities(row.allowedCapabilities);
  return {
    enabled: row.enabled,
    capabilities: [BASELINE_VISITOR_CAPABILITY, ...extras],
    ttlMinutes:
      Number.isInteger(row.sessionTtlMinutes) && row.sessionTtlMinutes > 0
        ? row.sessionTtlMinutes
        : DEFAULT_VISITOR_TTL_MINUTES,
    recordVisits: row.recordVisits,
  };
}

/** Whether a resolved scope grants a given capability. */
export function visitorCan(
  scope: VisitorScope,
  capability: VisitorCapability,
): boolean {
  return scope.capabilities.includes(capability);
}

/**
 * Map a requested federation mutation/interaction key to the visitor
 * capability it requires.
 *
 * `key` is the mutation `type` or interaction `action` discriminant.
 *
 * Returned value semantics:
 * - a {@link VisitorCapability} — a non-owner visitor may perform this action
 *   only when that capability is in their resolved scope.
 * - `null` — the action is NEVER grantable to a federated visitor (authoring,
 *   social-graph, membership-projection, and KG operations are owner/peer-only
 *   regardless of visitor settings, as is any unknown key).
 *
 * Owner sessions and trusted peer-authenticated requests bypass this map
 * entirely; it only constrains a non-owner acting via the `rivr_remote_viewer`
 * cookie.
 */
export function requiredVisitorCapability(
  key: string | undefined,
): VisitorCapability | null {
  switch (key) {
    case "react":
    case "toggleReaction":
      return "react";
    case "createComment":
      return "comment";
    case "rsvp":
      return "rsvp";
    case "message_thread_start":
      return "message";
    default:
      return null;
  }
}
