// src/lib/federation/visit-log.ts
//
// Best-effort recorder for federated-visitor landings.
//
// When a cross-instance visitor is auto-signed-in by the SSO lander
// (`/api/federation/sso/land`), the owner may want to know who came by and how
// they got here — their referral path (where global bounced them from and
// where they landed), their home instance, and a few low-sensitivity request
// signals. This module appends one row per landing to `federated_visit_log`.
//
// Privacy/robustness posture:
// - Recording is gated by the owner's `recordVisits` setting (resolved into the
//   {@link VisitorScope}); the lander only calls this when recording is on.
// - This is a side-channel: a failure here must NEVER block the landing or
//   strand the visitor, so every path is wrapped and swallowed.

import { db } from "@/db";
import { federatedVisitLog } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import type { VisitorCapability } from "@/lib/federation/visitor-scope";

/** Header carrying the document the visitor navigated from, when present. */
const REFERER_HEADER = "referer";
/** Header carrying the visitor's user-agent string. */
const USER_AGENT_HEADER = "user-agent";

/** Inputs needed to record one federated-visitor landing. */
export interface RecordFederatedVisitParams {
  /** The verified visitor's canonical actor id. */
  visitorActorId: string;
  /** Whether the visitor is the instance owner (`PRIMARY_AGENT_ID`). */
  isOwner: boolean;
  /** The visitor's home instance base URL (from the SSO assertion). */
  homeBaseUrl: string;
  /** The global identity authority that issued the assertion. */
  globalIssuerBaseUrl: string;
  /** Sanitized same-origin path the visitor was sent to (`next`). */
  landingPath: string;
  /** Display name from the assertion, when present. */
  visitorName?: string;
  /** Effective capabilities granted to this visitor for the session. */
  grantedScope: VisitorCapability[];
  /** The incoming landing request, used to read referer/user-agent headers. */
  request: Request;
}

/**
 * Append a single landing row to `federated_visit_log`. Best-effort: any error
 * (table missing pre-migration, transient DB issue) is swallowed so the
 * landing/session flow is never disrupted.
 *
 * @returns Nothing — fire-and-await for ordering, but never throws.
 */
export async function recordFederatedVisit(
  params: RecordFederatedVisitParams,
): Promise<void> {
  try {
    const { instanceId } = getInstanceConfig();
    const referrer = params.request.headers.get(REFERER_HEADER);
    const userAgent = params.request.headers.get(USER_AGENT_HEADER);

    await db.insert(federatedVisitLog).values({
      instanceId,
      visitorActorId: params.visitorActorId,
      isOwner: params.isOwner,
      homeBaseUrl: params.homeBaseUrl,
      globalIssuerBaseUrl: params.globalIssuerBaseUrl,
      landingPath: params.landingPath,
      referrer: referrer ?? null,
      visitorName: params.visitorName ?? null,
      userAgent: userAgent ?? null,
      grantedScope: params.grantedScope,
      authMethod: "federated-sso",
    });
  } catch {
    /* best-effort: visit logging must never block a landing */
  }
}
