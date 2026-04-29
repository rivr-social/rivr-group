/**
 * OAuth callback for the per-group Google Workspace flow.
 *
 * Path is intentionally STATIC — `groupId` lives only in the signed `state`,
 * not in the URL. Google OAuth Console requires a fixed redirect_uri
 * allow-list, which can't include a `[groupId]` segment.
 *
 * Verifies the signed state, exchanges the authorization code for tokens,
 * fetches the userinfo email, then upserts a `groupConnections` row keyed
 * by `(groupId, 'google_workspace')`.
 *
 * Auth: caller must be signed in AND admin of the target group at callback
 * time. The signed state in the cookie is verified for both nonce match
 * and HMAC signature so a leaked cookie alone cannot drive an upsert.
 *
 * On success: clears the state cookie and redirects to
 * `/groups/[groupId]/settings/connections`.
 * On failure: redirects to the same page with `?error=<stable_code>` so the
 * UI can render a deterministic message. If state parsing fails before we
 * know the target group, redirects to the canonical sign-in route with
 * `?error=state_invalid` since there is no group context to bounce back to.
 */

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/db';
import { groupConnections } from '@/db/schema';
import { isGroupAdmin } from '@/app/actions/group-admin';
import {
  GOOGLE_OAUTH_ERRORS,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_COOKIE_PATH,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_WORKSPACE_PROVIDER,
  GROUP_GOOGLE_CALLBACK_PATH,
  type GoogleOAuthErrorCode,
} from '@/lib/google/constants';

export const dynamic = 'force-dynamic';

/** Maximum bytes of provider error body to log. Keeps logs tidy. */
const PROVIDER_ERROR_LOG_LIMIT = 500;

/** Canonical sign-in route. Mirrors the global redirect target used elsewhere. */
const LOGIN_PATH = '/auth/login';

/**
 * Stable error code surfaced when state parsing fails BEFORE we know the
 * target group, so we can't redirect back to the Connections page. Routed
 * to the login page instead.
 */
const STATE_INVALID_ERROR = 'state_invalid';

/**
 * Build a redirect URL back to the group's settings page with the
 * Connections tab pre-selected, optionally carrying a stable error code.
 * Caller must already know the target groupId (i.e. signed state has been
 * parsed successfully).
 *
 * The tab UI lives on the unified settings page; the standalone
 * `/settings/connections` route remains valid for direct deep links but
 * the OAuth round-trip prefers the tab so the user lands back in the
 * familiar settings shell.
 */
function buildRedirect(
  baseUrl: string,
  groupId: string,
  errorCode?: GoogleOAuthErrorCode,
): URL {
  const url = new URL(`/groups/${groupId}/settings`, baseUrl);
  url.searchParams.set('tab', 'connections');
  if (errorCode) {
    url.searchParams.set('error', errorCode);
  }
  return url;
}

/**
 * Build a neutral redirect to the login page when we have no group context
 * (state parsing failed before we could read `groupId`).
 */
function buildNeutralErrorRedirect(baseUrl: string): URL {
  const url = new URL(LOGIN_PATH, baseUrl);
  url.searchParams.set('error', STATE_INVALID_ERROR);
  return url;
}

/**
 * HMAC-verify the nonce against the AUTH_SECRET-bound signature.
 *
 * Caller is responsible for ensuring `secret` is non-empty — verifying with
 * `''` would silently accept any forged signature, so the GET handler
 * fails closed with `state_misconfigured` before reaching here.
 */
function verifySignature(
  secret: string,
  nonce: string,
  groupId: string,
  userId: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${nonce}.${groupId}.${userId}`)
    .digest('hex');

  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
}

/** Parse the encoded `state` parameter, returning null on any tamper. */
function parseState(
  raw: string | null,
): { groupId: string; userId: string; nonce: string; signature: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as {
      groupId?: string;
      userId?: string;
      nonce?: string;
      signature?: string;
    };
    if (
      typeof parsed.groupId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.signature !== 'string'
    ) {
      return null;
    }
    return {
      groupId: parsed.groupId,
      userId: parsed.userId,
      nonce: parsed.nonce,
      signature: parsed.signature,
    };
  } catch {
    return null;
  }
}

/**
 * Read the signed nonce previously written by the connect route. We do not
 * use Next's cookie helper here because the route is GET-only and we want
 * to also clear the cookie atomically on the response below.
 */
function readStateCookie(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  const entry = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`));
  if (!entry) return null;
  return entry.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1) || null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    url.origin;

  // Parse signed state FIRST — `groupId` only exists inside it now. If
  // parsing fails we cannot redirect to a group-specific page, so we
  // bounce to the login page with a neutral error.
  const parsed = parseState(url.searchParams.get('state'));
  if (!parsed) {
    console.error(
      `[group-google-callback] state missing or unparseable at ${GROUP_GOOGLE_CALLBACK_PATH}`,
    );
    return NextResponse.redirect(buildNeutralErrorRedirect(baseUrl));
  }

  const parsedGroupId = parsed.groupId;

  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    console.error(
      `[group-google-callback] provider error for group ${parsedGroupId}: ${errorParam.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.PROVIDER_ERROR),
    );
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.CODE_MISSING),
    );
  }

  // Fail-closed: an empty AUTH_SECRET would silently disable the HMAC
  // tamper check on the state nonce. Bounce back to the Connections UI
  // with a stable code the operator can act on.
  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) {
    return NextResponse.redirect(
      buildRedirect(
        baseUrl,
        parsedGroupId,
        GOOGLE_OAUTH_ERRORS.STATE_MISCONFIGURED,
      ),
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL(LOGIN_PATH, baseUrl));
  }

  const isAdmin = await isGroupAdmin(session.user.id, parsedGroupId);
  if (!isAdmin) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.FORBIDDEN),
    );
  }

  if (parsed.userId !== session.user.id) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  const cookieNonce = readStateCookie(request);
  if (!cookieNonce || cookieNonce !== parsed.nonce) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  if (
    !verifySignature(
      authSecret,
      parsed.nonce,
      parsed.groupId,
      parsed.userId,
      parsed.signature,
    )
  ) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, parsedGroupId, GOOGLE_OAUTH_ERRORS.NOT_CONFIGURED),
    );
  }

  // STATIC redirect_uri — must match exactly what the connect route used
  // and what is registered in Google Console's allow-list.
  const redirectUri =
    process.env.GOOGLE_GROUP_REDIRECT_URI?.trim() ||
    `${baseUrl}${GROUP_GOOGLE_CALLBACK_PATH}`;

  const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error(
      `[group-google-callback] token exchange failed for group ${parsedGroupId}: ${errorText.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(
        baseUrl,
        parsedGroupId,
        GOOGLE_OAUTH_ERRORS.TOKEN_EXCHANGE_FAILED,
      ),
    );
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    id_token?: string;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(
      buildRedirect(
        baseUrl,
        parsedGroupId,
        GOOGLE_OAUTH_ERRORS.NO_ACCESS_TOKEN,
      ),
    );
  }

  const userinfoResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    cache: 'no-store',
  });

  if (!userinfoResponse.ok) {
    const errorText = await userinfoResponse.text();
    console.error(
      `[group-google-callback] userinfo failed for group ${parsedGroupId}: ${errorText.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(
        baseUrl,
        parsedGroupId,
        GOOGLE_OAUTH_ERRORS.USERINFO_FAILED,
      ),
    );
  }

  const profile = (await userinfoResponse.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  };

  if (!profile.email) {
    return NextResponse.redirect(
      buildRedirect(
        baseUrl,
        parsedGroupId,
        GOOGLE_OAUTH_ERRORS.USERINFO_FAILED,
      ),
    );
  }

  const expiresAt =
    typeof tokenData.expires_in === 'number'
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

  const [existing] = await db
    .select({
      id: groupConnections.id,
      refreshToken: groupConnections.refreshToken,
      config: groupConnections.config,
    })
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, parsedGroupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  // Default config: disabled until the admin opts in.
  const defaultConfig = {
    smtpEnabled: false as boolean,
    calendarSyncEnabled: false as boolean,
  };
  const nextConfig = existing?.config ?? defaultConfig;

  // Google's `sub` is the stable account identifier across email aliases;
  // fall back to the email when `sub` is absent so we always have a
  // non-null lookup key for "which group owns this Google account".
  const providerAccountId = profile.sub ?? profile.email;

  const baseValues = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? existing?.refreshToken ?? null,
    tokenType: tokenData.token_type ?? 'Bearer',
    expiresAt,
    scope: tokenData.scope ?? null,
    accountEmail: profile.email,
    providerAccountId,
    config: nextConfig,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(groupConnections)
      .set({
        ...baseValues,
        connectedByUserId: session.user.id,
      })
      .where(eq(groupConnections.id, existing.id));
  } else {
    await db.insert(groupConnections).values({
      groupId: parsedGroupId,
      provider: GOOGLE_WORKSPACE_PROVIDER,
      connectedByUserId: session.user.id,
      ...baseValues,
    });
  }

  const response = NextResponse.redirect(buildRedirect(baseUrl, parsedGroupId));
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: GOOGLE_OAUTH_STATE_COOKIE_PATH,
  });

  return response;
}
