/**
 * POST /api/agents/mirror — create a local placeholder agent row for a
 * remote user discovered via federated search.
 *
 * Purpose:
 * - Group admins want to invite a Rivr user who hasn't visited this peer
 *   yet. The admin picker surfaces remote users via the global user-search
 *   endpoint; picking one needs a local row so it can be stored in
 *   `metadata.adminIds` / ledger and selected in subsequent UI.
 * - This endpoint writes that placeholder, tagged `metadata.remoteOnly=true`
 *   and `metadata.authMethod='admin-invite'` so it is distinguishable from
 *   rows created on first federated login (`authMethod='federated-sso'`).
 *
 * Auth: authenticated session OR remote_viewer cookie. No credential-holder
 *   restriction — any logged-in user may mirror, but rate-limited.
 *
 * Idempotency: `onConflictDoUpdate` merges metadata so repeated calls for
 *   the same actor are safe; existing rows never regress to remote-only.
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSession } from "@/lib/auth/get-session";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";

const IP_RATE_LIMIT_MAX = 30;
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MirrorBody {
  id?: unknown;
  name?: unknown;
  email?: unknown;
  homeBaseUrl?: unknown;
  avatarUrl?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  // Require a logged-in caller — getSession unifies NextAuth + federated
  // remote-viewer cookie; either is acceptable for mirror invites.
  const session = await getSession();
  const callerId = session?.user?.id ?? null;
  if (!callerId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const clientIp = getClientIp(request.headers);
  const limit = await rateLimit(
    `agents-mirror:ip:${clientIp}`,
    IP_RATE_LIMIT_MAX,
    IP_RATE_LIMIT_WINDOW_MS,
  );
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  let body: MirrorBody;
  try {
    body = (await request.json()) as MirrorBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const id = typeof body.id === "string" ? body.id : null;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
  const homeBaseUrl =
    typeof body.homeBaseUrl === "string" && body.homeBaseUrl.trim()
      ? body.homeBaseUrl.trim()
      : null;
  const avatarUrl =
    typeof body.avatarUrl === "string" && body.avatarUrl.trim() ? body.avatarUrl.trim() : null;

  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json(
      { error: "`id` must be a UUID" },
      { status: STATUS_BAD_REQUEST },
    );
  }
  if (!name && !email) {
    return NextResponse.json(
      { error: "`name` or `email` is required" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    await db
      .insert(agents)
      .values({
        id,
        name: name ?? email ?? "Federated user",
        type: "person",
        email,
        image: avatarUrl,
        metadata: {
          remoteOnly: true,
          homeBaseUrl,
          authMethod: "admin-invite",
          invitedBy: callerId,
          mirroredAt: new Date().toISOString(),
        },
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: sql`COALESCE(EXCLUDED.name, ${agents.name})`,
          email: sql`COALESCE(EXCLUDED.email, ${agents.email})`,
          image: sql`COALESCE(EXCLUDED.image, ${agents.image})`,
          metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || EXCLUDED.metadata`,
        },
      });
  } catch (error) {
    console.error("[agents/mirror] upsert failed:", error);
    return NextResponse.json(
      { error: "Internal error" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }

  return NextResponse.json(
    { ok: true, id, homeBaseUrl, remoteOnly: true },
    { status: STATUS_OK },
  );
}
