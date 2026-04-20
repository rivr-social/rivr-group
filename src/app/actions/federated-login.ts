"use server";

/**
 * Server actions for federated-SSO login (issue #102).
 *
 * Purpose:
 * - Encapsulate the client-facing login flow that:
 *   1. calls the global identity authority's `POST /api/federation/sso/issue`
 *      with email/handle + password + this peer's base URL,
 *   2. posts the resulting signed assertion to this peer's
 *      `POST /api/federation/remote-auth`, which sets the
 *      `rivr_remote_viewer` cookie,
 *   3. on either-side 401, falls back to the local NextAuth credentials
 *      provider via `loginAction`, so users whose `identity_authority`
 *      row has not been provisioned yet continue to work during the
 *      signup migration (#101/#21).
 *
 * Security constraints:
 * - Never surface "global rejected you" vs "this peer rejected you" vs
 *   "local credentials rejected you" differences. The action collapses
 *   all auth failures to the same generic "Invalid email or password"
 *   error so the response cannot be used as an enumeration oracle.
 * - Password length is validated before any network call (NIST SP 800-63B
 *   minimum + bcrypt 72-byte maximum). This matches the constraints
 *   already enforced by `src/auth.ts`, keeping behaviour identical for
 *   callers that bypass the form.
 * - Rate limiting is delegated: global's `/sso/issue` has its own per-IP
 *   and per-identity limits, and `loginAction` rate-limits the local
 *   fallback. This action does not add a third layer.
 *
 * Key exports:
 * - {@link federatedLoginAction}
 * - {@link FederatedLoginResult}
 *
 * Dependencies:
 * - `@/app/actions/auth` — local credentials fallback.
 * - `@/lib/federation/instance-config` — this peer's base URL.
 * - `fetch` — transport to global and to the local `/remote-auth` route.
 *   Using the Web fetch rather than a custom HTTP client keeps this
 *   server action portable between Node and Edge runtimes.
 */

import { headers } from "next/headers";
import { loginAction } from "./auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

import {
  DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL,
  type FederatedLoginDeps,
  type FederatedLoginInput,
  type FederatedLoginMethod,
  type FederatedLoginResult,
} from "./federated-login-types";

/** Minimum password length — NIST SP 800-63B, matches local auth flow. */
const MINIMUM_PASSWORD_LENGTH = 8;

/** Maximum password length — bcrypt truncates past 72 bytes. */
const MAXIMUM_PASSWORD_LENGTH = 72;

/** Cap on any single identifier (email/handle) to prevent payload bombs. */
const MAX_IDENTITY_LENGTH = 320;

/**
 * Network timeout for the upstream SSO call. 10s is generous enough for a
 * bcrypt verify on a cold pod while keeping the login form from hanging
 * indefinitely if global is unreachable.
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Generic failure string — never leak which layer rejected the user. */
const GENERIC_AUTH_FAILURE = "Invalid email or password.";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Public types moved to ./federated-login-types to satisfy Next.js 15's
// "use server" restriction that only async functions may be exported.

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Execute the federated-SSO login flow with local-credentials fallback.
 *
 * @param input User-provided identifiers + password.
 * @param deps Injection surface for tests. Defaults to production wiring.
 * @returns Success envelope describing which path authenticated the user,
 *   or a generic failure string on every rejection mode.
 */
export async function federatedLoginAction(
  input: FederatedLoginInput,
  deps: FederatedLoginDeps = {},
): Promise<FederatedLoginResult> {
  const validated = validateInput(input);
  if (!validated.ok) {
    return { success: false, error: validated.error };
  }
  const body = validated.value;

  const targetBaseUrl = deps.targetBaseUrl ?? resolveTargetBaseUrl();
  if (!targetBaseUrl) {
    // We cannot compute a target URL → only local credentials are possible.
    return runLocalFallback(body, deps);
  }

  const globalUrl =
    deps.globalIdentityAuthorityUrl ?? resolveGlobalIdentityAuthorityUrl();

  const fetchImpl = deps.fetchImpl ?? fetch;
  const ssoIssueUrl = new URL(
    "/api/federation/sso/issue",
    globalUrl,
  ).toString();
  const remoteAuthUrl = new URL(
    "/api/federation/remote-auth",
    targetBaseUrl,
  ).toString();

  // Step 1: ask global to mint a signed assertion.
  const issueResponse = await safeFetch(fetchImpl, ssoIssueUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(body.email ? { email: body.email } : {}),
      ...(body.handle ? { handle: body.handle } : {}),
      password: body.password,
      targetBaseUrl,
    }),
  });

  if (!issueResponse.ok) {
    // 401 from global → fall back to local credentials (covers users whose
    // identity_authority row hasn't been provisioned yet).
    // Any non-200 other than 401 also falls back rather than failing hard,
    // so global outages never strand a legitimate local user.
    return runLocalFallback(body, deps);
  }

  let assertion: unknown;
  try {
    assertion = await issueResponse.json();
  } catch {
    // If global returned a success code with an unparseable body, treat
    // that as total failure rather than silently falling back — we cannot
    // construct the downstream call without a real assertion.
    return { success: false, error: GENERIC_AUTH_FAILURE };
  }

  // Step 2: hand the assertion to this peer's remote-auth endpoint so it
  // can verify + set the viewer cookie.
  const remoteResponse = await safeFetch(fetchImpl, remoteAuthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assertion),
  });

  if (!remoteResponse.ok) {
    // Verify failed on this peer — do NOT fall back to local credentials
    // here because we have a signed assertion from global that this peer
    // actively rejected. That is a real security signal, not a "this user
    // hasn't migrated yet" signal.
    return { success: false, error: GENERIC_AUTH_FAILURE };
  }

  // Forward the Set-Cookie header returned by remote-auth to the browser.
  const setCookieHeader = remoteResponse.headers.get("set-cookie");
  if (deps.applyRemoteViewerCookie) {
    await deps.applyRemoteViewerCookie(setCookieHeader);
  } else if (setCookieHeader) {
    await forwardSetCookieToCurrentResponse(setCookieHeader);
  }

  let summary: {
    homeBaseUrl?: string;
    globalIssuerBaseUrl?: string;
  } = {};
  try {
    const parsed = (await remoteResponse.json()) as {
      homeBaseUrl?: unknown;
      globalIssuerBaseUrl?: unknown;
    };
    if (typeof parsed.homeBaseUrl === "string") {
      summary.homeBaseUrl = parsed.homeBaseUrl;
    }
    if (typeof parsed.globalIssuerBaseUrl === "string") {
      summary.globalIssuerBaseUrl = parsed.globalIssuerBaseUrl;
    }
  } catch {
    // Non-fatal: the cookie is already set; we just lose the UI badge info.
  }

  return {
    success: true,
    method: "federated-sso",
    ...summary,
  };
}

// ---------------------------------------------------------------------------
// Local fallback
// ---------------------------------------------------------------------------

/**
 * Run the local NextAuth credentials provider as a fallback. Used when:
 * - global returns 401 (no identity_authority row yet), or
 * - global is unreachable / returns anything non-2xx, or
 * - the peer cannot derive its own base URL, so federated SSO is impossible.
 *
 * Handles only the email+password code path; `handle`-only logins cannot
 * fall back to local because NextAuth credentials requires an email today.
 */
async function runLocalFallback(
  body: ValidatedInput,
  deps: FederatedLoginDeps,
): Promise<FederatedLoginResult> {
  if (!body.email) {
    return { success: false, error: GENERIC_AUTH_FAILURE };
  }
  const fallback = deps.localLoginFallback ?? loginAction;
  const result = await fallback(body.email, body.password);
  if (!result.success) {
    return {
      success: false,
      // Pass through rate-limit / verify-your-email messages since those
      // are already user-safe in the local action.
      error: result.error ?? GENERIC_AUTH_FAILURE,
    };
  }
  return { success: true, method: "local-credentials" };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface ValidatedInput {
  email?: string;
  handle?: string;
  password: string;
  homeBaseUrlHint?: string;
}

type ValidateResult =
  | { ok: true; value: ValidatedInput }
  | { ok: false; error: string };

function validateInput(raw: FederatedLoginInput): ValidateResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: GENERIC_AUTH_FAILURE };
  }

  const email = normalizeEmail(raw.email);
  const handle = normalizeHandle(raw.handle);
  if (!email && !handle) {
    return { ok: false, error: "Email or handle is required." };
  }
  if (email && handle) {
    return {
      ok: false,
      error: "Provide only one of email or handle, not both.",
    };
  }

  const password = raw.password;
  if (typeof password !== "string") {
    return { ok: false, error: "Password is required." };
  }
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be ${MAXIMUM_PASSWORD_LENGTH} characters or fewer.`,
    };
  }

  const homeBaseUrlHint =
    typeof raw.homeBaseUrlHint === "string" && raw.homeBaseUrlHint.trim()
      ? raw.homeBaseUrlHint.trim()
      : undefined;

  return {
    ok: true,
    value: {
      ...(email ? { email } : {}),
      ...(handle ? { handle } : {}),
      password,
      ...(homeBaseUrlHint ? { homeBaseUrlHint } : {}),
    },
  };
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_IDENTITY_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  return lower.includes("@") ? lower : null;
}

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_IDENTITY_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  if (lower.includes("@")) return null; // Prefer email path for "a@b.c" values.
  return lower.startsWith("@") ? lower.slice(1) : lower;
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the global identity authority URL. Precedence:
 *   1. explicit `GLOBAL_IDENTITY_AUTHORITY_URL` env var
 *   2. {@link DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL} (a.rivr.social)
 */
function resolveGlobalIdentityAuthorityUrl(): string {
  const envUrl = process.env.GLOBAL_IDENTITY_AUTHORITY_URL?.trim();
  if (envUrl) {
    try {
      return new URL(envUrl).origin;
    } catch {
      // Fall through to default.
    }
  }
  return DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL;
}

/**
 * Resolve this peer's base URL from `getInstanceConfig()`.
 *
 * Production value is set by `BASE_URL`/`NEXT_PUBLIC_BASE_URL`. If neither
 * is defined and we're on localhost, we return `null` and the action falls
 * back to local credentials rather than telling global to mint an
 * assertion for `http://localhost:3000`.
 */
function resolveTargetBaseUrl(): string | null {
  const config = getInstanceConfig();
  if (!config.baseUrl) return null;
  if (config.baseUrl.includes("localhost")) return null;
  try {
    return new URL(config.baseUrl).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch + cookie plumbing
// ---------------------------------------------------------------------------

interface SafeFetchResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
}

/**
 * Fetch wrapper that:
 * - applies a hard timeout so a hung upstream cannot block the action,
 * - normalizes network errors to `{ ok: false }` so callers can branch on
 *   `.ok` without a try/catch at every call site,
 * - returns a minimal shape that matches Response for injection tests.
 */
async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<SafeFetchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      json: async () => ({}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Forward the `Set-Cookie` header returned by `/remote-auth` to the
 * browser that invoked this server action. Next.js's server-actions
 * runtime collects `cookies()` mutations and serializes them onto the
 * redirect/response, so we parse the upstream cookie and re-apply it.
 */
async function forwardSetCookieToCurrentResponse(
  setCookieHeader: string,
): Promise<void> {
  const parsed = parseSetCookieHeader(setCookieHeader);
  if (!parsed) return;

  // Lazy import so the module stays tree-shakeable when the action is
  // used from environments (e.g. unit tests) without `next/headers`.
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  jar.set(parsed.name, parsed.value, {
    httpOnly: parsed.httpOnly,
    secure: parsed.secure,
    sameSite: parsed.sameSite,
    path: parsed.path,
    maxAge: parsed.maxAge,
  });
}

interface ParsedCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge?: number;
}

/**
 * Minimal `Set-Cookie` parser covering the attributes we actually emit
 * from `/api/federation/remote-auth`. Cookie values that NextResponse
 * writes do not contain `,` so we intentionally parse only the first
 * cookie and ignore any trailing concatenation.
 */
function parseSetCookieHeader(raw: string): ParsedCookie | null {
  if (!raw) return null;
  const [firstPair, ...attrs] = raw.split(";").map((s) => s.trim());
  if (!firstPair) return null;
  const eqIdx = firstPair.indexOf("=");
  if (eqIdx <= 0) return null;

  const name = firstPair.slice(0, eqIdx).trim();
  const value = firstPair.slice(eqIdx + 1).trim();
  if (!name || !value) return null;

  const parsed: ParsedCookie = {
    name,
    value,
    httpOnly: false,
    secure: false,
    sameSite: "lax",
    path: "/",
  };

  for (const attr of attrs) {
    const [k, v] = attr.split("=").map((s) => s.trim());
    const key = k.toLowerCase();
    if (key === "httponly") parsed.httpOnly = true;
    else if (key === "secure") parsed.secure = true;
    else if (key === "path" && v) parsed.path = v;
    else if (key === "max-age" && v) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) parsed.maxAge = n;
    } else if (key === "samesite" && v) {
      const lower = v.toLowerCase();
      if (lower === "lax" || lower === "strict" || lower === "none") {
        parsed.sameSite = lower;
      }
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Header access for future telemetry / debugging
// ---------------------------------------------------------------------------

/**
 * Exposed for future use — currently unused but kept so adding request
 * context (IP, UA) to federated login audit logs is a one-liner without
 * another round of wiring.
 */
export async function readRequestContext(): Promise<{
  ip: string;
  userAgent: string;
}> {
  const headerList = await headers();
  const ip = headerList.get("x-real-ip") ?? "unknown";
  const userAgent = headerList.get("user-agent") ?? "unknown";
  return { ip, userAgent };
}
