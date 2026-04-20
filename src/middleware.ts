/**
 * @module middleware
 *
 * Next.js edge middleware for authentication gating and security headers.
 *
 * Responsibilities:
 * 1. **Route protection** -- unauthenticated requests to non-public routes are
 *    redirected to `/auth/login` (pages) or receive a 401 JSON response (API).
 *    A request counts as authenticated when **either** a valid NextAuth JWT
 *    is present **or** a signed, unexpired `rivr_remote_viewer` cookie from a
 *    federated-SSO session verifies against `AUTH_SECRET` (issue #105).
 * 2. **Content Security Policy** -- a per-request nonce is generated and injected
 *    into a strict CSP header to mitigate XSS attacks.
 * 3. **Security hardening** -- HSTS, X-Content-Type-Options, X-Frame-Options,
 *    and Referrer-Policy headers are applied to every response.
 * 4. **POST filtering** -- non-Server-Action, non-form POST requests to page
 *    routes are short-circuited with 204 to prevent CSRF-style abuse.
 *
 * The `config.matcher` excludes static assets and metadata files so the
 * middleware only runs on navigational and API requests.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { isPublicRoute } from "@/lib/route-access";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  type RemoteViewerSessionPayload,
} from "@/lib/federation/remote-viewer-session-types";
import { decodeRemoteViewerSessionEdge } from "@/lib/federation/remote-viewer-session-edge";

/**
 * Builds a Content-Security-Policy header string with a per-request nonce.
 *
 * `'unsafe-eval'` and `'wasm-unsafe-eval'` are always included in `script-src`
 * because CesiumJS requires eval for dynamic module loading and WebAssembly
 * compilation for geospatial computations.
 *
 * @param nonce - A Base64-encoded UUID unique to this request.
 * @returns The complete CSP header value.
 */
function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const matrixUrl = process.env.NEXT_PUBLIC_MATRIX_HOMESERVER_URL;
  const matrixWss = matrixUrl?.replace(/^https:\/\//, "wss://");
  const publicDomain = process.env.NEXT_PUBLIC_DOMAIN?.trim();
  const minioPublicUrl = process.env.ASSET_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_MINIO_URL?.trim();
  const imageSources = [
    "'self'",
    "data:",
    "blob:",
    "http://localhost:9000",
    ...(minioPublicUrl ? [minioPublicUrl] : []),
    ...(publicDomain ? [`https://s3.${publicDomain}`] : []),
    "http://*.virtualearth.net",
    "http://dev.virtualearth.net",
    "https://*.virtualearth.net",
    "https://dev.virtualearth.net",
    "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.org",
    "https://tiles.hydrosheds.org",
    "https://api.mapbox.com",
    "https://*.mapbox.com",
    "https://*.arcgisonline.com",
    "https://*.arcgis.com",
    "https://api.cesium.com",
    "https://assets.cesium.com",
    "https://*.cesium.com",
    "https://*.stripe.com",
  ];

  // Resolve the app's own origin so HMR WebSockets and fetch work behind Traefik
  const appUrl = process.env.NEXTAUTH_URL?.trim();
  const appWss = appUrl?.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

  const connectSources = [
    "'self'",
    "ws://localhost:*",
    "wss://localhost:*",
    "http://localhost:*",
    "https://localhost:*",
    "http://127.0.0.1:*",
    "https://127.0.0.1:*",
    ...(appUrl ? [appUrl] : []),
    ...(appWss ? [appWss] : []),
    "https://api.stripe.com",
    "https://api.mapbox.com",
    "https://*.mapbox.com",
    "https://*.arcgisonline.com",
    "https://*.arcgis.com",
    "https://api.cesium.com",
    "https://assets.cesium.com",
    "https://*.cesium.com",
    "http://*.virtualearth.net",
    "http://dev.virtualearth.net",
    "https://*.virtualearth.net",
    "https://dev.virtualearth.net",
    "https://ibasemaps-api.arcgis.com",
    "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.org",
    "https://tiles.hydrosheds.org",
    "https://photon.komoot.io",
    "https://nominatim.openstreetmap.org",
    ...(matrixUrl ? [matrixUrl] : []),
    ...(matrixWss ? [matrixWss] : []),
  ];

  // In dev mode, use 'unsafe-inline' for scripts to avoid CSP noise from
  // next-themes, HMR, and other dev-time inline scripts that lack nonces.
  // In production, enforce nonce-based CSP for proper XSS protection.
  // The sha256 hash whitelists the next-themes inline script that prevents FOUC.
  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://js.stripe.com`
    : `script-src 'self' 'nonce-${nonce}' 'sha256-n46vPwSWuMC0W703pBofImv82Z26xo4LXymv0E9caPk=' 'unsafe-eval' 'wasm-unsafe-eval' https://js.stripe.com`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    `img-src ${Array.from(new Set(imageSources)).join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Applies security-related HTTP headers to a response.
 *
 * Sets CSP, HSTS (2-year max-age with preload), nosniff, DENY framing,
 * and strict referrer policy. The nonce is also exposed via `x-nonce`
 * so that server components can read it and inject it into inline scripts.
 *
 * @param response - The NextResponse to augment.
 * @param cspHeader - Pre-built CSP header string.
 * @param nonce - The per-request nonce.
 * @returns The same response object with headers set (mutated in place).
 */
function applySecurityHeaders(response: NextResponse, cspHeader: string, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  response.headers.set("x-nonce", nonce);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Next.js edge middleware entry point.
 *
 * Execution flow:
 * 1. Generate a per-request CSP nonce.
 * 2. Filter suspicious non-Server-Action POST requests to page routes.
 * 3. Allow public routes through with security headers.
 * 4. For protected routes, verify the JWT; redirect or 401 if absent.
 * 5. Forward the nonce via the `x-nonce` request header so downstream
 *    server components can access it.
 *
 * @param request - The incoming Next.js request.
 * @returns A NextResponse with security headers applied.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const nonce = btoa(crypto.randomUUID());
  const cspHeader = buildCspHeader(nonce);
  const method = request.method.toUpperCase();
  // Filter non-API POST requests that are neither Server Actions nor form
  // submissions. This prevents bare POST requests from being processed as
  // page navigations, which could be used for CSRF-style attacks.
  const isPagePost = method === "POST" && !pathname.startsWith("/api/");
  if (isPagePost) {
    const nextAction = request.headers.get("next-action");
    const contentType = request.headers.get("content-type") ?? "";
    const isFormPost =
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data");
    const allowPath = pathname.startsWith("/auth/");
    if (!nextAction && !isFormPost && !allowPath) {
      const response = new NextResponse(null, { status: 204 });
      return applySecurityHeaders(response, cspHeader, nonce);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const forcePublicPrefixes = [
    "/api/mcp",
    "/api/profile/",
    "/api/schema-schema",
    "/.well-known/mcp",
  ];

  if (forcePublicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  if (isPublicRoute(pathname)) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  // Behind a TLS-terminating reverse proxy (Traefik), the internal request
  // arrives over HTTP even though the browser connected via HTTPS. Detect the
  // original protocol so getToken looks for the correct cookie name
  // (__Secure-authjs.session-token vs authjs.session-token).
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isSecure =
    forwardedProto === "https" || request.nextUrl.protocol === "https:";

  const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;

  const token = await getToken({
    req: request,
    secret: authSecret,
    secureCookie: isSecure,
  });

  // Fall back to the federated `rivr_remote_viewer` cookie when NextAuth is
  // absent. This lets peer users who signed in via global's SSO flow (issue
  // #102 / #105) authorize downstream requests without also carrying a local
  // NextAuth JWT. The cookie is HMAC-verified and expire-checked on every
  // request; a valid signature alone is not enough if `exp` has passed.
  let remoteViewer: RemoteViewerSessionPayload | null = null;
  if (!token && authSecret) {
    const rawCookie = request.cookies.get(REMOTE_VIEWER_COOKIE_NAME)?.value;
    if (rawCookie) {
      remoteViewer = await decodeRemoteViewerSessionEdge(rawCookie, authSecret);
    }
  }

  if (!token && !remoteViewer) {
    if (pathname.startsWith("/api/")) {
      const response = NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
      return applySecurityHeaders(response, cspHeader, nonce);
    }

    const loginUrl = new URL("/auth/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    const response = NextResponse.redirect(loginUrl);
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  // Forward the verified remote-viewer identity to downstream handlers via
  // request headers so route-level code that does not re-verify the cookie
  // can still reason about the authenticated actor. Route handlers that gate
  // on capability / projection MUST still call `getSession()` — these headers
  // are a hint, not a trust boundary.
  if (remoteViewer && !token) {
    requestHeaders.set("x-remote-viewer-actor-id", remoteViewer.actorId);
    requestHeaders.set("x-remote-viewer-auth-method", remoteViewer.authMethod);
    if (remoteViewer.homeBaseUrl) {
      requestHeaders.set("x-remote-viewer-home", remoteViewer.homeBaseUrl);
    }
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  return applySecurityHeaders(response, cspHeader, nonce);
}

/**
 * Middleware route matcher configuration.
 *
 * The regex excludes Next.js internal routes (_next/static, _next/image),
 * metadata files (favicon, sitemap, robots), and static asset file
 * extensions to ensure the middleware only processes navigational
 * and API requests.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except static files and metadata:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - Cesium public runtime assets under /Cesium
     * - Public GeoJSON datasets under /geojson
     * - favicon.ico, sitemap.xml, robots.txt
     * - Static assets (images, fonts, json data)
     */
    "/((?!_next/static|_next/image|Cesium/|geojson/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.(?:html|svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|xml|json|geojson)$).*)",
  ],
};
