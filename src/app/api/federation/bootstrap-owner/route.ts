/**
 * One-time instance-owner bootstrap for a freshly provisioned sovereign group.
 *
 * Purpose:
 * - Stamp the primary group agent's `groupType` and its FIRST admin/owner.
 *
 * Security model (hardened 2026-08-15, finding GRP-SEC-001):
 * - This route grants org-wide admin (and, via `isGroupAdmin`'s `path_ids`
 *   cascade, admin over every nested circle). It is therefore an OPERATOR
 *   action, not a visitor action.
 * - Two independent gates must BOTH pass:
 *   1. `authorizeFederationRequest` — the same operator credential every other
 *      `/api/federation` write route requires (hosted-node owner session,
 *      per-peer secret, or `NODE_ADMIN_KEY`).
 *   2. A one-time-bootstrap guard — the request is refused with 409 when the
 *      primary agent already has ANY admin (`metadata.adminIds` non-empty) or
 *      already carries a `metadata.sourceOwner` stamp.
 * - The remote-viewer cookie is still required, because it is what supplies the
 *   identity being stamped as owner — but it is no longer sufficient on its own.
 *   Previously it was the ONLY check, so any federated visitor holding the
 *   30-minute `rivr_remote_viewer` cookie minted by `/api/federation/sso/land`
 *   could POST here and append themselves to `metadata.adminIds`.
 *
 * Dependencies:
 * - `@/lib/federation-auth` for the operator credential check.
 * - `@/lib/federation-remote-session` for the owner identity being stamped.
 * - `@/lib/federation/instance-config` for the primary agent binding.
 */
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { REMOTE_VIEWER_COOKIE_NAME, validateRemoteViewerToken } from "@/lib/federation-remote-session";
import {
  STATUS_BAD_REQUEST,
  STATUS_CONFLICT,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";

function normalizeGroupType(value: string | null): "organization" | "family" | "ring" | null {
  if (!value) return null;
  const type = value.trim().toLowerCase();
  if (type === "org") return "organization";
  if (type === "organization" || type === "family" || type === "ring") return type;
  return null;
}

function mapGroupTypeToAgentType(groupType: "organization" | "family" | "ring"): "organization" | "family" | "ring" {
  if (groupType === "family") return "family";
  if (groupType === "ring") return "ring";
  return "organization";
}

/**
 * True when this instance's primary agent has already been claimed, in which
 * case the bootstrap must never run again. Both signals are checked because
 * either one on its own proves a prior claim: `adminIds` is what the route
 * grants, `sourceOwner` is what it stamps.
 */
function isAlreadyBootstrapped(metadata: Record<string, unknown>, existingAdminIds: string[]): boolean {
  if (existingAdminIds.length > 0) return true;
  const sourceOwner = metadata.sourceOwner;
  return typeof sourceOwner === "object" && sourceOwner !== null;
}

export async function POST(request: Request) {
  const config = getInstanceConfig();

  // Gate 1 — operator credential. Fail closed BEFORE reading any state so an
  // unauthenticated caller learns nothing about this instance's claim status.
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json(
      { success: false, error: authorization.reason ?? "Federation operator credential required" },
      { status: STATUS_FORBIDDEN },
    );
  }

  const cookieToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
    ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);

  if (!cookieToken) {
    return NextResponse.json({ success: false, error: "No remote session cookie" }, { status: STATUS_UNAUTHORIZED });
  }

  const session = validateRemoteViewerToken(cookieToken, config.instanceId);
  if (!session) {
    return NextResponse.json({ success: false, error: "Invalid remote session cookie" }, { status: STATUS_UNAUTHORIZED });
  }

  if (!config.primaryAgentId) {
    return NextResponse.json(
      { success: false, error: "This group instance has no PRIMARY_AGENT_ID configured" },
      { status: STATUS_CONFLICT },
    );
  }

  const body = (await request.json().catch(() => ({} as Record<string, unknown>))) as {
    groupType?: string;
  };
  const groupType = normalizeGroupType(typeof body.groupType === "string" ? body.groupType : null);
  if (!groupType) {
    return NextResponse.json(
      { success: false, error: "groupType is required (organization | family | ring)" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const primary = await db.query.agents.findFirst({
    where: and(eq(agents.id, config.primaryAgentId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      metadata: true,
    },
  });
  if (!primary) {
    return NextResponse.json({ success: false, error: "Primary group agent not found" }, { status: STATUS_NOT_FOUND });
  }

  const metadata = (primary.metadata ?? {}) as Record<string, unknown>;
  const existingAdminIds = Array.isArray(metadata.adminIds)
    ? metadata.adminIds.filter((value): value is string => typeof value === "string")
    : [];

  // Gate 2 — one-time bootstrap. An already-claimed instance grants admin only
  // through the normal in-app admin surfaces, never through this route.
  if (isAlreadyBootstrapped(metadata, existingAdminIds)) {
    return NextResponse.json(
      {
        success: false,
        error: "This group instance already has an owner. Grant admin through group settings instead.",
      },
      { status: STATUS_CONFLICT },
    );
  }

  const adminIds = [session.actorId];
  const now = new Date();

  await db
    .update(agents)
    .set({
      type: mapGroupTypeToAgentType(groupType),
      metadata: {
        ...metadata,
        groupType,
        adminIds,
        sourceOwner: {
          actorId: session.actorId,
          homeBaseUrl: session.homeBaseUrl,
          linkedAt: now.toISOString(),
        },
      },
      updatedAt: now,
    })
    .where(eq(agents.id, primary.id));

  return NextResponse.json({
    success: true,
    groupType,
    primaryAgentId: primary.id,
    sourceOwner: {
      actorId: session.actorId,
      homeBaseUrl: session.homeBaseUrl,
    },
  });
}
