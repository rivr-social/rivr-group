/**
 * Admin API for per-instance outgoing SMTP configuration (ticket #106).
 *
 * Routes:
 *   GET    /api/admin/smtp-config   — return the current config for
 *                                     this instance (no secret value).
 *   POST   /api/admin/smtp-config   — upsert the config.
 *   DELETE /api/admin/smtp-config   — remove the config so the mailer
 *                                     falls back to the global relay.
 *
 * Auth: gated behind `metadata.siteRole === "admin"` on the calling
 * agent's row — matches the convention already used by
 * `src/app/api/debug/counts/route.ts` and `src/app/actions/admin.ts`.
 *
 * Security:
 *   - The request body contains a `passwordSecretRef`, NEVER a
 *     plaintext password. The reference is either a `process.env`
 *     variable name or a Docker secret mount path.
 *   - GET responses never include resolved credentials — only the
 *     reference string, which already lives in a plain text column.
 *   - Every write invalidates the in-memory peer SMTP config cache
 *     and the pooled transporter so the next send picks up changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, peerSmtpConfig } from "@/db/schema";
import {
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resetPeerSmtpConfigCache } from "@/lib/federation/peer-smtp";
import { resetPeerSmtpTransportCache } from "@/lib/federation/peer-smtp-transport";

export const ADMIN_FORBIDDEN_MESSAGE =
  "Forbidden: admin privileges required";
export const UNAUTHORIZED_MESSAGE = "Authentication required";

// ---------------------------------------------------------------------------
// Shared auth gate
// ---------------------------------------------------------------------------

/**
 * Verify the caller has platform-admin privileges. Shared across the
 * three handlers in this module. Matches the pattern in
 * `src/app/actions/admin.ts` / `src/app/api/debug/counts/route.ts`.
 *
 * @returns A NextResponse error when the caller is unauthorized/forbidden,
 *   or null when the caller is authorized.
 */
export async function requireAdminOrRespond(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: UNAUTHORIZED_MESSAGE },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  const metadata =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  if (metadata.siteRole !== "admin") {
    return NextResponse.json(
      { error: ADMIN_FORBIDDEN_MESSAGE },
      { status: STATUS_FORBIDDEN },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export interface SmtpConfigUpsertBody {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  passwordSecretRef: string;
}

/**
 * Parse + validate a POST body. Returns a discriminated union so the
 * route can emit a 400 with a specific field-level error message.
 */
export function parseUpsertBody(
  raw: unknown,
): { ok: true; value: SmtpConfigUpsertBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (typeof body.host !== "string" || body.host.trim().length === 0) {
    return { ok: false, error: "host is required" };
  }
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "port must be an integer 1..65535" };
  }
  if (typeof body.secure !== "boolean") {
    return { ok: false, error: "secure must be a boolean" };
  }
  if (typeof body.username !== "string" || body.username.trim().length === 0) {
    return { ok: false, error: "username is required" };
  }
  if (
    typeof body.fromAddress !== "string" ||
    body.fromAddress.trim().length === 0
  ) {
    return { ok: false, error: "fromAddress is required" };
  }
  if (
    typeof body.passwordSecretRef !== "string" ||
    body.passwordSecretRef.trim().length === 0
  ) {
    return { ok: false, error: "passwordSecretRef is required" };
  }
  // Defense-in-depth: block anything that looks like a plaintext password
  // sneaking in instead of a reference. A reference is either a shell
  // env-var token or an absolute path. Spaces and '@' almost always
  // indicate a real password or email has been pasted by mistake.
  const refLooksLikePlaintext =
    /\s/.test(body.passwordSecretRef) ||
    body.passwordSecretRef.includes("@");
  if (refLooksLikePlaintext) {
    return {
      ok: false,
      error:
        "passwordSecretRef must be an env var name (e.g. PEER_SMTP_PASSWORD) or absolute secret path (e.g. /run/secrets/peer_smtp_password) — not a plaintext password",
    };
  }

  return {
    ok: true,
    value: {
      enabled: body.enabled,
      host: body.host.trim(),
      port,
      secure: body.secure,
      username: body.username.trim(),
      fromAddress: body.fromAddress.trim(),
      passwordSecretRef: body.passwordSecretRef.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function shapeRowForClient(
  row: typeof peerSmtpConfig.$inferSelect,
): Record<string, unknown> {
  return {
    id: row.id,
    instanceId: row.instanceId,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.fromAddress,
    passwordSecretRef: row.passwordSecretRef,
    lastTestAt:
      row.lastTestAt instanceof Date
        ? row.lastTestAt.toISOString()
        : row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    lastTestError: row.lastTestError,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /api/admin/smtp-config */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  void _request;
  const denied = await requireAdminOrRespond();
  if (denied) return denied;

  const { instanceId } = getInstanceConfig();
  const rows = await db
    .select()
    .from(peerSmtpConfig)
    .where(eq(peerSmtpConfig.instanceId, instanceId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      { ok: true, config: null },
      { status: STATUS_OK },
    );
  }

  return NextResponse.json(
    { ok: true, config: shapeRowForClient(row) },
    { status: STATUS_OK },
  );
}

/** POST /api/admin/smtp-config (upsert) */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAdminOrRespond();
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

  const parsed = parseUpsertBody(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const { instanceId } = getInstanceConfig();

  try {
    const existing = await db
      .select({ id: peerSmtpConfig.id })
      .from(peerSmtpConfig)
      .where(eq(peerSmtpConfig.instanceId, instanceId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(peerSmtpConfig)
        .set({
          enabled: parsed.value.enabled,
          host: parsed.value.host,
          port: parsed.value.port,
          secure: parsed.value.secure,
          username: parsed.value.username,
          fromAddress: parsed.value.fromAddress,
          passwordSecretRef: parsed.value.passwordSecretRef,
          updatedAt: new Date(),
        })
        .where(eq(peerSmtpConfig.instanceId, instanceId));
    } else {
      await db.insert(peerSmtpConfig).values({
        instanceId,
        enabled: parsed.value.enabled,
        host: parsed.value.host,
        port: parsed.value.port,
        secure: parsed.value.secure,
        username: parsed.value.username,
        fromAddress: parsed.value.fromAddress,
        passwordSecretRef: parsed.value.passwordSecretRef,
      });
    }

    resetPeerSmtpConfigCache();
    resetPeerSmtpTransportCache();

    const [row] = await db
      .select()
      .from(peerSmtpConfig)
      .where(eq(peerSmtpConfig.instanceId, instanceId))
      .limit(1);

    return NextResponse.json(
      { ok: true, config: row ? shapeRowForClient(row) : null },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[admin/smtp-config] upsert failed: ${message}`);
    return NextResponse.json(
      { ok: false, error: "Failed to save SMTP config" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}

/** DELETE /api/admin/smtp-config */
export async function DELETE(_request: NextRequest): Promise<NextResponse> {
  void _request;
  const denied = await requireAdminOrRespond();
  if (denied) return denied;

  const { instanceId } = getInstanceConfig();
  const existing = await db
    .select({ id: peerSmtpConfig.id })
    .from(peerSmtpConfig)
    .where(eq(peerSmtpConfig.instanceId, instanceId))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No SMTP config to delete" },
      { status: STATUS_NOT_FOUND },
    );
  }

  await db
    .delete(peerSmtpConfig)
    .where(eq(peerSmtpConfig.instanceId, instanceId));

  resetPeerSmtpConfigCache();
  resetPeerSmtpTransportCache();

  return NextResponse.json({ ok: true }, { status: STATUS_OK });
}
