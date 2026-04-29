/**
 * Initiates the Google Workspace OAuth flow for a group.
 *
 * Auth: caller must be signed in AND admin/moderator of the target group.
 *
 * Flow:
 * 1. Resolve session and verify `isGroupAdmin`.
 * 2. Generate a cryptographic nonce, sign it with AUTH_SECRET, and serialize
 *    `{ groupId, userId, nonce }` into the OAuth `state` parameter.
 * 3. Set the signed nonce in a short-lived HTTP-only cookie scoped to this
 *    route so the callback can verify it.
 * 4. Redirect to Google's consent screen with the configured scopes,
 *    `access_type=offline`, and `prompt=consent` so we always get a
 *    refresh_token.
 *
 * Failure modes (all redirect back to the Connections page with `?error=`):
 * - 401 / 403 if the caller is not an admin (returned as JSON, not redirect,
 *   so unauthorized callers get a clear error rather than a misleading UI).
 * - `not_configured` if GOOGLE_CLIENT_ID is missing.
 */

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isGroupAdmin } from '@/app/actions/group-admin';
import {
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_ERRORS,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS,
} from '@/lib/google/constants';

export const dynamic = 'force-dynamic';

/** Signed-state nonce length in bytes; 32 = 256 bits of entropy. */
const STATE_NONCE_BYTES = 32;

/**
 * Build a redirect URL back to the group's Connections settings page.
 * The error code (when present) is appended as a query parameter so the
 * UI can render a stable, user-facing message.
 */
function buildRedirect(
  baseUrl: string,
  groupId: string,
  errorCode?: string,
): URL {
  const url = new URL(`/groups/${groupId}/settings/connections`, baseUrl);
  if (errorCode) {
    url.searchParams.set('error', errorCode);
  }
  return url;
}

/**
 * HMAC-sign the state nonce with AUTH_SECRET so the callback can detect
 * tampering even if the cookie is leaked or replayed across flows.
 */
function signState(nonce: string, groupId: string, userId: string): string {
  const secret = process.env.AUTH_SECRET ?? '';
  return crypto
    .createHmac('sha256', secret)
    .update(`${nonce}.${groupId}.${userId}`)
    .digest('hex');
}

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await context.params;
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const isAdmin = await isGroupAdmin(session.user.id, groupId);
  if (!isAdmin) {
    return NextResponse.json(
      { error: GOOGLE_OAUTH_ERRORS.FORBIDDEN },
      { status: 403 },
    );
  }

  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    new URL(request.url).origin;

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.NOT_CONFIGURED),
    );
  }

  const redirectUri =
    process.env.GOOGLE_GROUP_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/group/${groupId}/connections/google/callback`;

  const nonce = crypto.randomBytes(STATE_NONCE_BYTES).toString('hex');
  const signature = signState(nonce, groupId, session.user.id);
  const stateValue = JSON.stringify({
    groupId,
    userId: session.user.id,
    nonce,
    signature,
  });
  const stateEncoded = Buffer.from(stateValue, 'utf8').toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: stateEncoded,
  });

  const response = NextResponse.redirect(
    `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`,
  );
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS,
    path: `/api/group/${groupId}/connections/google`,
  });

  return response;
}
