/**
 * Federation SSO landing consumer: the sovereign side of the global→home
 * pre-authenticated handoff (no-mirror UM v0.4 work, issue
 * rivr-social/rivr-app#102).
 *
 * Flow:
 * - Global's `/api/federation/sso/session-handoff` mints a short-lived,
 *   audience-bound Ed25519 assertion for the CURRENT global session user
 *   and 302-redirects the browser here with
 *   `?assertion=<base64url-json>&next=<relative-path>`.
 * - This route verifies the assertion LOCALLY against global's public key
 *   (resolved from the `nodes` peer row) via {@link verifySsoAssertion} —
 *   no HMAC secret crosses the wire and no callback to the issuer is made.
 *   On success it mints the same `rivr_remote_viewer` session cookie the
 *   `/api/federation/remote-auth` POST path sets, so the existing viewer
 *   machinery (middleware + federated-login reader) honors it, then
 *   redirects to `next`.
 *
 * This is the GET/redirect sibling of the existing POST `remote-auth`
 * verifier; it exists so global can bounce a browser straight here with a
 * URL rather than requiring a client-side JSON POST.
 *
 * Security:
 * - Audience-bound to this instance's origin → a token minted for another
 *   peer cannot be replayed here.
 * - Issuer allow-listed to `GLOBAL_IDENTITY_AUTHORITY_URL`.
 * - Verification failure never strands the user: it falls through to the
 *   sanitized local `next` unauthenticated so they can log in normally.
 */

import { NextResponse } from "next/server";

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
import { STATUS_INTERNAL_ERROR } from "@/lib/http-status";

/** Default post-landing destination when no (valid) `next` is supplied. */
const DEFAULT_NEXT = "/";

/** Session lifetime for the minted viewer cookie, in seconds. */
const VIEWER_SESSION_LIFETIME_SEC = REMOTE_VIEWER_DEFAULT_LIFETIME_SEC;

/** Constrain `next` to a safe same-document relative path. */
function sanitizeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//")) return DEFAULT_NEXT;
  if (raw.includes("\\")) return DEFAULT_NEXT;
  return raw;
}

/** Decode a base64url-encoded JSON assertion param. Returns null on failure. */
function decodeAssertionParam(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Derive the base URL this peer expects SSO assertions to target. Mirrors
 * the helper in the POST `remote-auth` route so the audience binding is
 * computed identically.
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

/** Heuristic: are we serving HTTPS? Honors `X-Forwarded-Proto`. */
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

export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const config = getInstanceConfig();
  const expectedTarget = deriveExpectedTargetBaseUrl(request, config.baseUrl);
  const localRedirectBase = expectedTarget ?? config.baseUrl;
  const next = sanitizeNext(requestUrl.searchParams.get("next"));

  if (!expectedTarget) {
    return NextResponse.json(
      { error: "Instance base URL not configured" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": "no-store" } },
    );
  }

  const assertion = decodeAssertionParam(requestUrl.searchParams.get("assertion"));
  if (assertion === null) {
    return NextResponse.redirect(new URL(next, localRedirectBase), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  let result: SsoAssertionVerifyResult;
  try {
    result = await verifySsoAssertion({
      assertion,
      expectedTargetBaseUrl: expectedTarget,
      expectedGlobalIssuerBaseUrl:
        process.env.GLOBAL_IDENTITY_AUTHORITY_URL ?? undefined,
    });
  } catch (error) {
    console.error("[federation/sso/land] verify threw:", error);
    return NextResponse.redirect(new URL(next, localRedirectBase), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (!result.ok) {
    // Bad/expired/forged assertion must not authenticate, but also must not
    // strand the user — fall through to the local destination unauthenticated.
    console.warn(`[federation/sso/land] rejected assertion: reason=${result.reason}`);
    return NextResponse.redirect(new URL(next, localRedirectBase), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const claims = result.claims;

  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error("[federation/sso/land] AUTH_SECRET missing; cannot mint viewer cookie");
    return NextResponse.redirect(new URL(next, localRedirectBase), {
      headers: { "Cache-Control": "no-store" },
    });
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
      console.error("[federation/sso/land] encode failed:", error);
      return NextResponse.redirect(new URL(next, localRedirectBase), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }

  const response = NextResponse.redirect(new URL(next, localRedirectBase), {
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: deriveIsHttps(request),
    sameSite: "lax",
    path: "/",
    maxAge: VIEWER_SESSION_LIFETIME_SEC,
  });
  return response;
}
