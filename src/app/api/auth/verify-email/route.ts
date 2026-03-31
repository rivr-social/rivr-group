/**
 * Email verification API route.
 *
 * Purpose:
 * Validates a one-time email verification token, marks it as consumed, and marks
 * the related agent account as email-verified before redirecting to login.
 *
 * Key exports:
 * - `GET`: Verifies the token and redirects with a `verified=true` query param.
 *
 * Dependencies:
 * - Next.js route primitives (`NextRequest`, `NextResponse`)
 * - Drizzle ORM query helpers (`eq`, `and`, `isNull`)
 * - Database client and schema tables (`db`, `agents`, `emailVerificationTokens`)
 * - Shared HTTP status constants
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/db';
import { agents, emailVerificationTokens } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { STATUS_BAD_REQUEST, STATUS_GONE } from '@/lib/http-status';
import { encode } from 'next-auth/jwt';
import { hashToken } from '@/lib/token-hash';

const TOKEN_TYPE = 'email_verification';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function getSessionCookie(useSecureCookies: boolean) {
  const cookiePrefix = useSecureCookies ? '__Secure-' : '';
  return {
    name: `${cookiePrefix}authjs.session-token`,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: useSecureCookies,
    },
  };
}

/**
 * Verifies an email-verification token and redirects to the login page.
 *
 * Security and business rules:
 * - Only unused tokens of type `email_verification` are accepted.
 * - Expired tokens are rejected with `410 Gone` to signal link invalidation.
 * - Tokens are single-use and marked consumed before account verification updates.
 *
 * Error handling pattern:
 * - Input/validation failures return JSON error responses with explicit status codes.
 * - Successful verification returns an HTTP redirect response.
 *
 * @param {NextRequest} request Incoming request that carries the `token` query parameter.
 * @returns {Promise<NextResponse>} JSON error response or redirect response to `/auth/login`.
 * @throws {Error} Propagates unexpected database/framework errors not explicitly handled.
 * @example
 * // GET /api/auth/verify-email?token=abc123
 * // -> 302 redirect to /auth/login?verified=true when token is valid.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const token = searchParams.get('token');

  // Treat missing/blank tokens as client input errors and fail fast.
  if (!token || token.trim().length === 0) {
    return NextResponse.json(
      { error: 'Missing verification token.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Query only active verification tokens:
  // - exact token match
  // - expected token type
  // - not already used
  // Hash the incoming token to match against stored hashed tokens
  const hashedToken = hashToken(token);
  const [record] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.token, hashedToken),
        eq(emailVerificationTokens.tokenType, TOKEN_TYPE),
        isNull(emailVerificationTokens.usedAt),
      ),
    )
    .limit(1);

  // Do not reveal whether a token ever existed beyond invalid/used semantics.
  if (!record) {
    return NextResponse.json(
      { error: 'Invalid or already-used verification token.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Enforce expiration to limit replay window for leaked links.
  if (record.expiresAt < new Date()) {
    return NextResponse.json(
      { error: 'Verification link has expired. Please request a new one.' },
      { status: STATUS_GONE },
    );
  }

  // Mark token as consumed to preserve one-time-use guarantees.
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokens.id, record.id));

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      image: agents.image,
    })
    .from(agents)
    .where(eq(agents.id, record.agentId))
    .limit(1);

  if (!agent) {
    return NextResponse.json(
      { error: 'Account not found for this verification token.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Persist verification state on the owning agent account.
  await db
    .update(agents)
    .set({ emailVerified: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, record.agentId));

  // Use NEXTAUTH_URL as the origin since request.nextUrl.origin reflects the
  // internal server address (e.g. 0.0.0.0:3000) when behind a reverse proxy.
  const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const isSecure =
    forwardedProto === 'https' ||
    request.nextUrl.protocol === 'https:' ||
    baseUrl.startsWith('https://');
  const sessionCookie = getSessionCookie(isSecure);
  const sessionSecret =
    process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;

  if (!sessionSecret) {
    return NextResponse.json(
      { error: 'Authentication secret is not configured.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const sessionToken = await encode({
    secret: sessionSecret,
    salt: sessionCookie.name,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      sub: agent.id,
      id: agent.id,
      name: agent.name,
      email: agent.email,
      picture: agent.image ?? undefined,
    },
  });

  const destination = new URL('/', baseUrl);
  destination.searchParams.set('verified', 'true');
  const response = NextResponse.redirect(destination);
  response.cookies.set(sessionCookie.name, sessionToken, {
    ...sessionCookie.options,
    expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
  });
  return response;
}
