/**
 * @module lib/auth/global-credential-authority
 *
 * Delegates password verification to global's universal credential register
 * (`identity_authority.credential_verifier`) by calling
 * `POST /api/federation/sso/issue`.
 *
 * Architecture: every RIVR instance — sovereign or hosted — verifies
 * credentials against global. The credential register survives the user
 * losing their sovereign instance (Ed25519 seed-phrase recovery restores
 * authority on global), so login works anywhere as long as global is
 * reachable.
 *
 * Trust model: this is a server-to-server fetch over TLS. The response is
 * signed (`SignedSsoAssertion`) but we accept TLS as sufficient
 * authentication of global itself; downstream consumers that need
 * cryptographic verification (e.g. `/api/federation/remote-auth`) re-verify
 * the signature.
 */

const DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL = "https://app.rivr.social";
const ISSUE_PATH = "/api/federation/sso/issue";
const REQUEST_TIMEOUT_MS = 10_000;

export interface VerifiedGlobalActor {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  homeBaseUrl: string;
  globalIssuerBaseUrl: string;
}

/**
 * Outcome of a credential check against the global identity authority.
 *
 * The distinction is security-critical (F12): the caller must NOT fall through
 * to local bcrypt on an explicit `rejected` (global evaluated the credential and
 * said no — e.g. wrong password or a revoked/migrating authority status), or a
 * blackholed/misconfigured global would silently re-enable a stale or revoked
 * local password hash. Local bcrypt fallback is only legitimate when global is
 * genuinely `unreachable` (network failure, timeout, 5xx, rate limit) — pure
 * outage resilience, not an authority decision.
 */
export type GlobalCredentialVerification =
  | { status: "verified"; actor: VerifiedGlobalActor }
  | { status: "rejected" }
  | { status: "unreachable" };

interface VerifyParams {
  email: string;
  password: string;
}

interface SsoIssueResponse {
  actorId?: string;
  email?: string;
  name?: string | null;
  avatarUrl?: string | null;
  homeBaseUrl?: string;
  globalIssuerBaseUrl?: string;
}

/**
 * Resolve the global identity authority URL. Precedence:
 *   1. explicit, valid `GLOBAL_IDENTITY_AUTHORITY_URL` env var (origin)
 *   2. in production: NONE — fail closed (throw)
 *   3. outside production: {@link DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL}
 *
 * Credential verification is delegated to this authority, so silently
 * defaulting under an env omission/misconfig could route a sovereign instance's
 * password checks at the wrong (e.g. non-prod) authority (AUTH-SEC-006a). In
 * production we therefore require it to be explicitly configured and valid, and
 * throw otherwise; non-prod still uses the default for local/dev.
 */
function resolveGlobalAuthorityUrl(): string {
  const envUrl = process.env.GLOBAL_IDENTITY_AUTHORITY_URL?.trim();
  if (envUrl) {
    try {
      return new URL(envUrl).origin;
    } catch {
      // Configured-but-malformed falls through to the not-configured handling.
    }
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "GLOBAL_IDENTITY_AUTHORITY_URL must be set to a valid URL in production; " +
        "refusing to fall back to a default credential authority.",
    );
  }
  return DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL.replace(/\/+$/, "");
}

function resolveTargetBaseUrl(): string | null {
  const candidates = [
    process.env.NEXTAUTH_URL,
    process.env.BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.length > 0) {
      try {
        return new URL(trimmed).origin;
      } catch {
        // Try next candidate.
      }
    }
  }
  return null;
}

export async function verifyWithGlobalIdentityAuthority(
  params: VerifyParams,
): Promise<GlobalCredentialVerification> {
  const targetBaseUrl = resolveTargetBaseUrl();
  if (!targetBaseUrl) {
    // We can't even form the request — a local misconfiguration, NOT an
    // authority rejection. Treat as unreachable so a misconfigured instance
    // degrades to local bcrypt rather than locking everyone out.
    console.warn(
      "[auth/global-credential-authority] NEXTAUTH_URL/BASE_URL not configured; cannot bind SSO assertion to a target",
    );
    return { status: "unreachable" };
  }

  const globalUrl = resolveGlobalAuthorityUrl();
  const issueUrl = `${globalUrl}${ISSUE_PATH}`;

  let response: Response;
  try {
    response = await fetch(issueUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        targetBaseUrl,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure / timeout / DNS — global is unreachable, not rejecting.
    console.warn(
      `[auth/global-credential-authority] fetch to ${issueUrl} failed:`,
      error,
    );
    return { status: "unreachable" };
  }

  if (!response.ok) {
    // 401 (identity-not-found OR wrong password) and 403 (revoked/migrating
    // authority status) are EXPLICIT credential rejections by the authority —
    // fail closed, never fall through to a stale local hash. Every other status
    // (400/415/429/5xx) is a transport/availability problem, not an authority
    // decision, so it degrades to the local bcrypt resilience path.
    if (response.status === 401 || response.status === 403) {
      return { status: "rejected" };
    }
    return { status: "unreachable" };
  }

  let data: SsoIssueResponse | null;
  try {
    data = (await response.json()) as SsoIssueResponse;
  } catch {
    // A 200 we can't parse is a broken authority response, not a verified
    // success and not an explicit reject — treat as unreachable.
    return { status: "unreachable" };
  }

  if (!data || typeof data.actorId !== "string" || data.actorId.length === 0) {
    return { status: "unreachable" };
  }

  return {
    status: "verified",
    actor: {
      id: data.actorId,
      email: typeof data.email === "string" && data.email.length > 0 ? data.email : null,
      name: typeof data.name === "string" && data.name.length > 0 ? data.name : null,
      image:
        typeof data.avatarUrl === "string" && data.avatarUrl.length > 0
          ? data.avatarUrl
          : null,
      homeBaseUrl:
        typeof data.homeBaseUrl === "string" && data.homeBaseUrl.length > 0
          ? data.homeBaseUrl
          : globalUrl,
      globalIssuerBaseUrl:
        typeof data.globalIssuerBaseUrl === "string" && data.globalIssuerBaseUrl.length > 0
          ? data.globalIssuerBaseUrl
          : globalUrl,
    },
  };
}
