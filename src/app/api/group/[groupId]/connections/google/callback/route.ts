/**
 * OAuth callback for the per-group Google Workspace flow.
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
 * UI can render a deterministic message.
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
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_WORKSPACE_PROVIDER,
  type GoogleOAuthErrorCode,
} from '@/lib/google/constants';

export const dynamic = 'force-dynamic';

/** Maximum bytes of provider error body to log. Keeps logs tidy. */
const PROVIDER_ERROR_LOG_LIMIT = 500;

/**
 * Build a redirect URL back to the group's Connections settings page,
 * optionally carrying a stable error code.
 */
function buildRedirect(
  baseUrl: string,
  groupId: string,
  errorCode?: GoogleOAuthErrorCode,
): URL {
  const url = new URL(`/groups/${groupId}/settings/connections`, baseUrl);
  if (errorCode) {
    url.searchParams.set('error', errorCode);
  }
  return url;
}

/** HMAC-verify the nonce against the AUTH_SECRET-bound signature. */
function verifySignature(
  nonce: string,
  groupId: string,
  userId: string,
  signature: string,
): boolean {
  const secret = process.env.AUTH_SECRET ?? '';
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

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await context.params;
  const url = new URL(request.url);

  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    url.origin;

  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    console.error(
      `[group-google-callback] provider error for group ${groupId}: ${errorParam.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.PROVIDER_ERROR),
    );
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.CODE_MISSING),
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', baseUrl));
  }

  const isAdmin = await isGroupAdmin(session.user.id, groupId);
  if (!isAdmin) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.FORBIDDEN),
    );
  }

  const parsed = parseState(url.searchParams.get('state'));
  if (!parsed) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.STATE_MISSING),
    );
  }

  if (parsed.groupId !== groupId || parsed.userId !== session.user.id) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  const cookieNonce = readStateCookie(request);
  if (!cookieNonce || cookieNonce !== parsed.nonce) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  if (!verifySignature(parsed.nonce, parsed.groupId, parsed.userId, parsed.signature)) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.STATE_MISMATCH),
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.NOT_CONFIGURED),
    );
  }

  const redirectUri =
    process.env.GOOGLE_GROUP_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/group/${groupId}/connections/google/callback`;

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
      `[group-google-callback] token exchange failed for group ${groupId}: ${errorText.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.TOKEN_EXCHANGE_FAILED),
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
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.NO_ACCESS_TOKEN),
    );
  }

  const userinfoResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    cache: 'no-store',
  });

  if (!userinfoResponse.ok) {
    const errorText = await userinfoResponse.text();
    console.error(
      `[group-google-callback] userinfo failed for group ${groupId}: ${errorText.slice(0, PROVIDER_ERROR_LOG_LIMIT)}`,
    );
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.USERINFO_FAILED),
    );
  }

  const profile = (await userinfoResponse.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  };

  if (!profile.email) {
    return NextResponse.redirect(
      buildRedirect(baseUrl, groupId, GOOGLE_OAUTH_ERRORS.USERINFO_FAILED),
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
        eq(groupConnections.groupId, groupId),
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

  const baseValues = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? existing?.refreshToken ?? null,
    tokenType: tokenData.token_type ?? 'Bearer',
    expiresAt,
    scope: tokenData.scope ?? null,
    accountEmail: profile.email,
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
      groupId,
      provider: GOOGLE_WORKSPACE_PROVIDER,
      connectedByUserId: session.user.id,
      ...baseValues,
    });
  }

  const response = NextResponse.redirect(buildRedirect(baseUrl, groupId));
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: `/api/group/${groupId}/connections/google`,
  });

  return response;
}
