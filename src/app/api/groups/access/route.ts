/**
 * @module api/groups/access
 *
 * REST API route for managing password-protected group memberships.
 * Provides full CRUD for group access: challenge (POST), check (GET),
 * revoke (DELETE), and renew (PATCH).
 *
 * This is the HTTP API counterpart to the server actions in
 * `@/app/actions/group-access`. It's used by clients that prefer
 * standard REST calls over Next.js server action invocations
 * (e.g. mobile apps, external integrations, or programmatic access).
 *
 * Key exports:
 * - POST: challenge a group password to gain membership
 * - GET: check if the current user has active membership
 * - DELETE: revoke a membership
 * - PATCH: renew an existing membership
 *
 * Dependencies:
 * - NextAuth session for authentication
 * - Group access server actions for business logic
 *
 * Security:
 * - All endpoints require an authenticated session.
 * - Group IDs and member IDs are validated as proper UUIDs.
 * - Password challenges use constant-time comparison (in the server action layer).
 *
 * @see src/app/actions/group-access.ts - underlying server actions
 * @see src/app/actions/group-admin.ts - admin-level group management
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  challengeGroupAccess,
  checkGroupMembership,
  revokeGroupMembership,
  renewGroupMembership,
} from "@/app/actions/group-access";
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
} from "@/lib/http-status";

/** UUID v1-v5 validation regex used for groupId and memberId parameters. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/groups/access
 *
 * Challenges a group password to obtain membership access. On success,
 * the authenticated user is granted a time-limited membership.
 *
 * Auth: Requires an authenticated session.
 *
 * @param request - Request with JSON body `{ groupId: string, password: string }`.
 * @returns A NextResponse with `{ membershipId, expiresAt }` on success,
 *   or `{ error }` with 400/401/403 status on failure.
 *
 * @example
 * ```ts
 * const res = await fetch("/api/groups/access", {
 *   method: "POST",
 *   body: JSON.stringify({ groupId: "uuid", password: "secret" }),
 * });
 * const { membershipId, expiresAt } = await res.json();
 * ```
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  let body: { groupId?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const { groupId, password } = body;

  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid or missing groupId" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  if (!password || typeof password !== "string") {
    return NextResponse.json(
      { error: "Password is required" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const result = await challengeGroupAccess(groupId, password);

  if (!result.success) {
    // Distinguish between wrong password (403 Forbidden) and other validation
    // errors (400 Bad Request) so clients can show appropriate UI feedback.
    const status = result.error === "Invalid group password." ? STATUS_FORBIDDEN : STATUS_BAD_REQUEST;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    membershipId: result.membershipId,
    expiresAt: result.expiresAt,
  });
}

/**
 * GET /api/groups/access?groupId=<uuid>
 *
 * Checks whether the currently authenticated user has an active membership
 * in the specified group. Returns membership details if active.
 *
 * Auth: Requires an authenticated session.
 *
 * @param request - Request with `groupId` query parameter.
 * @returns A NextResponse with the membership check result from the server action.
 *
 * @example
 * ```ts
 * const res = await fetch("/api/groups/access?groupId=uuid-here");
 * const { isMember, membershipId, expiresAt } = await res.json();
 * ```
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");

  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid or missing groupId" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const result = await checkGroupMembership(groupId);
  return NextResponse.json(result);
}

/**
 * DELETE /api/groups/access
 *
 * Revokes a group membership. The caller must be the membership owner
 * or a group admin (enforced in the server action layer).
 *
 * Auth: Requires an authenticated session.
 *
 * @param request - Request with JSON body `{ groupId: string, memberId: string }`.
 * @returns A NextResponse with `{ success: true }` on success,
 *   or `{ error }` with 400/401/403 status on failure.
 *
 * @example
 * ```ts
 * const res = await fetch("/api/groups/access", {
 *   method: "DELETE",
 *   body: JSON.stringify({ groupId: "uuid", memberId: "uuid" }),
 * });
 * ```
 */
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  let body: { groupId?: string; memberId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const { groupId, memberId } = body;

  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid or missing groupId" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  if (!memberId || !UUID_RE.test(memberId)) {
    return NextResponse.json(
      { error: "Invalid or missing memberId" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const result = await revokeGroupMembership(groupId, memberId);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: STATUS_FORBIDDEN });
  }

  return NextResponse.json({ success: true });
}

/**
 * PATCH /api/groups/access
 *
 * Renews an existing group membership, extending its expiration.
 * The caller must have a current (possibly expired) membership to renew.
 *
 * Auth: Requires an authenticated session.
 *
 * @param request - Request with JSON body `{ groupId: string }`.
 * @returns A NextResponse with `{ membershipId, expiresAt }` on success,
 *   or `{ error }` with 400/401 status on failure.
 *
 * @example
 * ```ts
 * const res = await fetch("/api/groups/access", {
 *   method: "PATCH",
 *   body: JSON.stringify({ groupId: "uuid" }),
 * });
 * const { membershipId, expiresAt } = await res.json();
 * ```
 */
export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  let body: { groupId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const { groupId } = body;

  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid or missing groupId" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const result = await renewGroupMembership(groupId);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: STATUS_BAD_REQUEST });
  }

  return NextResponse.json({
    membershipId: result.membershipId,
    expiresAt: result.expiresAt,
  });
}
