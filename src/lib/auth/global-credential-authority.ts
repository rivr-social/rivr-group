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

function resolveGlobalAuthorityUrl(): string {
  const raw = process.env.GLOBAL_IDENTITY_AUTHORITY_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL;
  return base.replace(/\/+$/, "");
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
): Promise<VerifiedGlobalActor | null> {
  const targetBaseUrl = resolveTargetBaseUrl();
  if (!targetBaseUrl) {
    console.warn(
      "[auth/global-credential-authority] NEXTAUTH_URL/BASE_URL not configured; cannot bind SSO assertion to a target",
    );
    return null;
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
    console.warn(
      `[auth/global-credential-authority] fetch to ${issueUrl} failed:`,
      error,
    );
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let data: SsoIssueResponse | null;
  try {
    data = (await response.json()) as SsoIssueResponse;
  } catch {
    return null;
  }

  if (!data || typeof data.actorId !== "string" || data.actorId.length === 0) {
    return null;
  }

  return {
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
  };
}
