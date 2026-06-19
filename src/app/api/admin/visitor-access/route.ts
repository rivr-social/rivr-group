/**
 * Owner API for per-instance federated-visitor access policy.
 *
 * Routes:
 *   GET  /api/admin/visitor-access  — return this instance's visitor policy
 *                                     (creating nothing; absent → safe default).
 *   POST /api/admin/visitor-access  — upsert the policy.
 *
 * What this governs:
 *   A federated visitor is a cross-instance SSO actor (NOT the instance owner)
 *   who lands via `/api/federation/sso/land` and is auto-signed-in with a
 *   `rivr_remote_viewer` cookie. This policy decides whether such visitors are
 *   admitted at all, which capabilities beyond the baseline `read` they hold,
 *   how long their session lasts, and whether their landings are logged.
 *
 * Auth: the instance OWNER only. On a group instance the owner is
 *   `PRIMARY_AGENT_ID`; we additionally honor `metadata.siteRole === "admin"`
 *   so the platform/global build (no primary agent) can still administer it.
 *
 * Security:
 *   - The baseline `read` capability is implicit and cannot be removed; the
 *     stored `allowed_capabilities` holds only the granted EXTRAS, narrowed by
 *     {@link sanitizeCapabilities} so an unknown/forged capability is dropped.
 *   - `read` itself is never persisted as an extra (sanitize strips it).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { agents, federatedVisitorSettings } from "@/db/schema";
import {
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  BASELINE_VISITOR_CAPABILITY,
  DEFAULT_VISITOR_TTL_MINUTES,
  defaultVisitorScope,
  sanitizeCapabilities,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";
import { parseVisitorAccessBody } from "@/lib/federation/visitor-access-policy";

const OWNER_FORBIDDEN_MESSAGE =
  "Forbidden: instance owner privileges required";
const UNAUTHORIZED_MESSAGE = "Authentication required";

// ---------------------------------------------------------------------------
// Owner auth gate
// ---------------------------------------------------------------------------

/**
 * Verify the caller is the instance owner (or platform admin). Returns a
 * NextResponse error when unauthorized/forbidden, or null when authorized.
 */
async function requireOwnerOrRespond(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: UNAUTHORIZED_MESSAGE },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const { primaryAgentId } = getInstanceConfig();

  // On a configured group instance the owner is the primary agent.
  if (primaryAgentId) {
    if (session.user.id === primaryAgentId) return null;
  }

  // Fallback (and the only path when no primary agent is configured): a
  // platform-admin agent. Matches the gate in `api/admin/smtp-config`.
  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);
  const metadata =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};
  if (metadata.siteRole === "admin") return null;

  return NextResponse.json(
    { error: OWNER_FORBIDDEN_MESSAGE },
    { status: STATUS_FORBIDDEN },
  );
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/** Shape a resolved scope for the client (includes implicit baseline). */
function shapeScope(scope: VisitorScope): Record<string, unknown> {
  return {
    enabled: scope.enabled,
    baselineCapability: BASELINE_VISITOR_CAPABILITY,
    capabilities: scope.capabilities,
    sessionTtlMinutes: scope.ttlMinutes,
    recordVisits: scope.recordVisits,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /api/admin/visitor-access */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  void _request;
  const denied = await requireOwnerOrRespond();
  if (denied) return denied;

  const { instanceId } = getInstanceConfig();
  const [row] = await db
    .select()
    .from(federatedVisitorSettings)
    .where(eq(federatedVisitorSettings.instanceId, instanceId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: true, config: shapeScope(defaultVisitorScope()) },
      { status: STATUS_OK },
    );
  }

  const scope: VisitorScope = {
    enabled: row.enabled,
    capabilities: [
      BASELINE_VISITOR_CAPABILITY,
      ...sanitizeCapabilities(row.allowedCapabilities),
    ],
    ttlMinutes:
      Number.isInteger(row.sessionTtlMinutes) && row.sessionTtlMinutes > 0
        ? row.sessionTtlMinutes
        : DEFAULT_VISITOR_TTL_MINUTES,
    recordVisits: row.recordVisits,
  };

  return NextResponse.json(
    { ok: true, config: shapeScope(scope) },
    { status: STATUS_OK },
  );
}

/** POST /api/admin/visitor-access (upsert) */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireOwnerOrRespond();
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be valid JSON" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const parsed = parseVisitorAccessBody(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const { instanceId } = getInstanceConfig();

  try {
    const existing = await db
      .select({ id: federatedVisitorSettings.id })
      .from(federatedVisitorSettings)
      .where(eq(federatedVisitorSettings.instanceId, instanceId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(federatedVisitorSettings)
        .set({
          enabled: parsed.value.enabled,
          allowedCapabilities: parsed.value.allowedCapabilities,
          sessionTtlMinutes: parsed.value.sessionTtlMinutes,
          recordVisits: parsed.value.recordVisits,
          updatedAt: new Date(),
        })
        .where(eq(federatedVisitorSettings.instanceId, instanceId));
    } else {
      await db.insert(federatedVisitorSettings).values({
        instanceId,
        enabled: parsed.value.enabled,
        allowedCapabilities: parsed.value.allowedCapabilities,
        sessionTtlMinutes: parsed.value.sessionTtlMinutes,
        recordVisits: parsed.value.recordVisits,
      });
    }

    const scope: VisitorScope = {
      enabled: parsed.value.enabled,
      capabilities: [
        BASELINE_VISITOR_CAPABILITY,
        ...parsed.value.allowedCapabilities,
      ],
      ttlMinutes: parsed.value.sessionTtlMinutes,
      recordVisits: parsed.value.recordVisits,
    };

    return NextResponse.json(
      { ok: true, config: shapeScope(scope) },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[admin/visitor-access] upsert failed: ${message}`);
    return NextResponse.json(
      { ok: false, error: "Failed to save visitor access policy" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
