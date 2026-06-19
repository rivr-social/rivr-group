// src/lib/federation/visitor-access-policy.ts
//
// Validation + bounds for the owner-controlled federated-visitor access policy
// consumed by `/api/admin/visitor-access`. Kept out of the route module so it
// is independently unit-testable (Next.js route files may only export request
// handlers).

import {
  sanitizeCapabilities,
  type VisitorCapability,
} from "@/lib/federation/visitor-scope";

/** Upper bound on a visitor session TTL (24h) — keep visitor cookies short. */
export const MAX_VISITOR_TTL_MINUTES = 24 * 60;
/** Lower bound on a visitor session TTL. */
export const MIN_VISITOR_TTL_MINUTES = 1;

/** Validated upsert payload for the visitor access policy. */
export interface VisitorAccessUpsertBody {
  enabled: boolean;
  /** Extra capabilities beyond the implicit baseline `read`. */
  allowedCapabilities: VisitorCapability[];
  sessionTtlMinutes: number;
  recordVisits: boolean;
}

/**
 * Parse + validate a POST body. Capabilities are narrowed to known,
 * non-baseline values via {@link sanitizeCapabilities} so the stored set is
 * always trustworthy. Returns a discriminated union so the route can emit a
 * 400 with a specific message.
 */
export function parseVisitorAccessBody(
  raw: unknown,
):
  | { ok: true; value: VisitorAccessUpsertBody }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (typeof body.recordVisits !== "boolean") {
    return { ok: false, error: "recordVisits must be a boolean" };
  }
  const ttl = Number(body.sessionTtlMinutes);
  if (
    !Number.isInteger(ttl) ||
    ttl < MIN_VISITOR_TTL_MINUTES ||
    ttl > MAX_VISITOR_TTL_MINUTES
  ) {
    return {
      ok: false,
      error: `sessionTtlMinutes must be an integer ${MIN_VISITOR_TTL_MINUTES}..${MAX_VISITOR_TTL_MINUTES}`,
    };
  }
  if (!Array.isArray(body.allowedCapabilities)) {
    return { ok: false, error: "allowedCapabilities must be an array" };
  }

  // Drop the baseline and any unknown/forged capability values.
  const allowedCapabilities = sanitizeCapabilities(body.allowedCapabilities);

  return {
    ok: true,
    value: {
      enabled: body.enabled,
      allowedCapabilities,
      sessionTtlMinutes: ttl,
      recordVisits: body.recordVisits,
    },
  };
}
