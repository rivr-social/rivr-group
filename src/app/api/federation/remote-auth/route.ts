/**
 * Federated-SSO acceptance endpoint for peer instances (issue #102).
 *
 * Purpose:
 * - Accept a signed SSO assertion minted by the global identity authority
 *   via `POST /api/federation/sso/issue`, verify the assertion against the
 *   issuer's public key stored in `nodes`, and set the short-lived
 *   `rivr_remote_viewer` cookie that represents a federated viewer session
 *   on this peer.
 * - Sibling write-path to `/api/federation/sso/issue`. Issue mints; this
 *   route verifies and grants a local session cookie.
 *
 * Endpoint:
 * - `POST /api/federation/remote-auth`
 * - Body: a fully signed assertion exactly as produced by
 *   `SignedSsoAssertion` in `@/lib/federation/sso-assertion`. The body is
 *   passed through the verifier as-is (no normalization) so the signature
 *   continues to cover every field the target trusts.
 *
 * Response shape (200):
 * ```json
 * {
 *   "ok": true,
 *   "actorId": "uuid",
 *   "homeBaseUrl": "https://alice.rivr.example",
 *   "globalIssuerBaseUrl": "https://global.rivr.social",
 *   "authMethod": "federated-sso",
 *   "expiresAt": 1713500500
 * }
 * ```
 *
 * Error codes:
 * - 400 — body is missing or not a signed-assertion shape.
 * - 401 — assertion is malformed, expired, audience-mismatched, issuer
 *         unknown, or signature invalid. All failure modes collapse to a
 *         single 401 so the route cannot be used as an issuer-discovery
 *         or audience-probing oracle (Cameron's constraint: "don't leak
 *         global's existence").
 * - 429 — per-IP rate limit hit.
 * - 500 — DB/crypto unavailable.
 *
 * Rate limiting:
 * - Per-IP bucket (30/min) matches `/api/federation/sso/issue`. An
 *   attacker spraying nonces across IPs still hits the per-issuer
 *   verification cost ceiling because the verifier short-circuits on
 *   audience mismatch before any DB work.
 *
 * Security posture:
 * - Audience binding is checked before signature verification so a valid
 *   assertion for a different target is cheap to reject.
 * - Single 401 response for every verify failure (see above).
 * - Cookie is HttpOnly, Secure on HTTPS, SameSite=Lax, Path=/.
 * - Cookie body is HMAC-SHA256 signed with `AUTH_SECRET` so an attacker
 *   that cannot read the process env cannot mint a session.
 */

import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  verifySsoAssertion,
  type SsoAssertionVerifyResult,
} from "@/lib/federation/sso-assertion";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  REMOTE_VIEWER_DEFAULT_LIFETIME_SEC,
  encodeRemoteViewerSession,
  RemoteViewerSessionError,
} from "@/lib/federation/remote-viewer-session";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
  STATUS_UNSUPPORTED_MEDIA_TYPE,
} from "@/lib/http-status";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Per-IP rate limit: 30 verifications per rolling minute. */
const IP_RATE_LIMIT_MAX = 30;
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Session lifetime for the `rivr_remote_viewer` cookie, in seconds.
 * Clamps to the module's hard ceiling (30d) inside the encoder; the
 * default (7d) matches the NextAuth JWT session lifetime on this app.
 */
const VIEWER_SESSION_LIFETIME_SEC = REMOTE_VIEWER_DEFAULT_LIFETIME_SEC;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST handler — verify a signed SSO assertion and set the viewer cookie.
 *
 * @param request Incoming fetch Request (expects `application/json`).
 * @returns Session summary on success; canonical error JSON otherwise.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: STATUS_UNSUPPORTED_MEDIA_TYPE },
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Per-IP rate limit (before any DB/crypto work).
  const clientIp = getClientIp(request.headers);
  const ipLimit = await rateLimit(
    `federation-remote-auth:ip:${clientIp}`,
    IP_RATE_LIMIT_MAX,
    IP_RATE_LIMIT_WINDOW_MS,
  );
  if (!ipLimit.success) {
    const retryAfterSec = Math.max(1, Math.ceil(ipLimit.resetMs / 1000));
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: STATUS_TOO_MANY_REQUESTS,
        headers: {
          "Retry-After": retryAfterSec.toString(),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const config = getInstanceConfig();
  const expectedTarget = deriveExpectedTargetBaseUrl(request, config.baseUrl);
  if (!expectedTarget) {
    // Instance misconfigured — we cannot safely verify an audience binding.
    return NextResponse.json(
      { error: "Instance base URL not configured" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }

  let result: SsoAssertionVerifyResult;
  try {
    result = await verifySsoAssertion({
      assertion: parsedBody,
      expectedTargetBaseUrl: expectedTarget,
      expectedGlobalIssuerBaseUrl:
        process.env.GLOBAL_IDENTITY_AUTHORITY_URL ?? undefined,
    });
  } catch (error) {
    console.error("[federation/remote-auth] verify threw:", error);
    return NextResponse.json(
      { error: "Internal error" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }

  if (!result.ok) {
    // Single 401 for every failure mode so this route cannot be used as
    // an audience/issuer probe.
    console.warn(
      `[federation/remote-auth] rejected assertion: reason=${result.reason}`,
    );
    return NextResponse.json(
      { error: "Invalid assertion" },
      {
        status: STATUS_UNAUTHORIZED,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const claims = result.claims;

  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error(
      "[federation/remote-auth] AUTH_SECRET missing; cannot mint viewer cookie",
    );
    return NextResponse.json(
      { error: "Internal error" },
      { status: STATUS_INTERNAL_ERROR },
    );
  }

  let cookieValue: string;
  try {
    cookieValue = encodeRemoteViewerSession(
      {
        actorId: claims.actorId,
        homeBaseUrl: claims.homeBaseUrl,
        globalIssuerBaseUrl: claims.globalIssuerBaseUrl,
        credentialVersion: claims.credentialVersion,
        homeAuthorityVersion: claims.homeAuthorityVersion,
        instanceClass: claims.instanceClass,
        parentAgentId: claims.parentAgentId,
        authMethod: "federated-sso",
        lifetimeSec: VIEWER_SESSION_LIFETIME_SEC,
      },
      secret,
    );
  } catch (error) {
    if (error instanceof RemoteViewerSessionError) {
      console.error("[federation/remote-auth] encode failed:", error);
      return NextResponse.json(
        { error: "Internal error" },
        { status: STATUS_INTERNAL_ERROR },
      );
    }
    throw error;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + VIEWER_SESSION_LIFETIME_SEC;
  const isHttps = deriveIsHttps(request);

  const response = NextResponse.json(
    {
      ok: true,
      actorId: claims.actorId,
      homeBaseUrl: claims.homeBaseUrl,
      globalIssuerBaseUrl: claims.globalIssuerBaseUrl,
      authMethod: "federated-sso" as const,
      expiresAt,
    },
    { status: STATUS_OK, headers: { "Cache-Control": "no-store" } },
  );

  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: VIEWER_SESSION_LIFETIME_SEC,
  });

  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the base URL this peer expects SSO assertions to target.
 *
 * Preferred source: `getInstanceConfig().baseUrl`. When running behind a
 * reverse proxy that already sets `Forwarded`/`X-Forwarded-*`, we fall back
 * to the reconstructed proto+host so the check still matches what the
 * client actually connected to.
 */
function deriveExpectedTargetBaseUrl(
  request: Request,
  configuredBaseUrl: string,
): string | null {
  if (configuredBaseUrl && !configuredBaseUrl.includes("localhost")) {
    return configuredBaseUrl;
  }
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (deriveIsHttps(request) ? "https" : "http");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    return `${proto}://${host}`;
  }
  return configuredBaseUrl || null;
}

/**
 * Heuristic: are we serving HTTPS? Honors `X-Forwarded-Proto` (Traefik
 * sets this) so cookies get the `Secure` flag in production even when the
 * internal request is HTTP.
 */
function deriveIsHttps(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
