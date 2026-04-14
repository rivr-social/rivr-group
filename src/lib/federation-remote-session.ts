import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";

const REMOTE_VIEWER_TOKEN_TYPE = "remote_viewer";
export const REMOTE_VIEWER_COOKIE_NAME = "rivr_remote_viewer";
export const REMOTE_VIEWER_TTL_MS = 30 * 60 * 1000;

export type RemoteViewerSessionPayload = {
  type: typeof REMOTE_VIEWER_TOKEN_TYPE;
  actorId: string;
  homeBaseUrl: string;
  localInstanceId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  persona?: FederatedAssertionPersonaContext;
};

export type FederatedAssertionPersonaContext = {
  personaId: string;
  personaDisplayName?: string;
  parentAgentId: string;
};

export type FederatedAssertionPayload = {
  "@context": "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld";
  "@type": "um:Assertion";
  subject: string;
  issuer: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  manifestUrl?: string;
  displayName?: string;
  persona?: FederatedAssertionPersonaContext;
  scope: {
    login: true;
    capabilities: string[];
    consents?: string[];
    spatialFabricRefs?: string[];
    dataFields?: string[];
  };
};

function resolveFederationSecret(): string {
  const authSecret = getEnv("AUTH_SECRET").trim();
  if (authSecret.length > 0) return authSecret;
  const adminKey = getEnv("NODE_ADMIN_KEY").trim();
  if (adminKey.length > 0) return adminKey;
  throw new Error("Federation signing secret is not configured");
}

function signPart(payloadB64: string): string {
  const secret = resolveFederationSecret();
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signPackedPayload(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signPart(payloadB64);
  return `${payloadB64}.${signature}`;
}

export function verifyPackedPayload<T>(token: string): T | null {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = signPart(payloadB64);
  if (!secureEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function createFederatedAssertion(params: {
  actorId: string;
  homeBaseUrl: string;
  audienceBaseUrl: string;
  manifestUrl?: string;
  displayName?: string;
  persona?: FederatedAssertionPersonaContext;
  capabilityScopes?: string[];
  consentScopes?: string[];
  spatialFabricRefs?: string[];
  dataFields?: string[];
  ttlMs?: number;
}): { token: string; payload: FederatedAssertionPayload } {
  const now = Date.now();
  const payload: FederatedAssertionPayload = {
    "@context": "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld",
    "@type": "um:Assertion",
    subject: params.actorId,
    issuer: params.homeBaseUrl,
    audience: params.audienceBaseUrl,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (params.ttlMs ?? 5 * 60 * 1000)).toISOString(),
    nonce: randomUUID(),
    manifestUrl: params.manifestUrl,
    displayName: params.displayName,
    ...(params.persona ? { persona: params.persona } : {}),
    scope: {
      login: true,
      capabilities: params.capabilityScopes ?? ["federation.login", "federation.mutate"],
      consents: params.consentScopes ?? ["metaverse.profilePublic", "spatial.locationShare"],
      spatialFabricRefs: params.spatialFabricRefs ?? [],
      dataFields:
        params.dataFields ?? [
          "profile.displayName",
          "profile.handle",
          "profile.avatar",
          "membership.groupIds",
          "membership.roles",
          "connections.counts",
        ],
    },
  };
  return { token: signPackedPayload(payload as unknown as Record<string, unknown>), payload };
}

export function validateFederatedAssertion(params: {
  token: string;
  actorId: string;
  homeBaseUrl: string;
  audienceBaseUrl: string;
  issuedAt: string;
  expiresAt: string;
}): { valid: true; payload: FederatedAssertionPayload } | { valid: false; error: string } {
  const payload = verifyPackedPayload<FederatedAssertionPayload>(params.token);
  if (!payload) return { valid: false, error: "Invalid assertion signature" };
  if (payload["@type"] !== "um:Assertion") return { valid: false, error: "Assertion type mismatch" };
  if (payload.subject !== params.actorId) return { valid: false, error: "Assertion subject mismatch" };
  if (payload.issuer !== params.homeBaseUrl) return { valid: false, error: "Assertion issuer mismatch" };
  if (payload.audience !== params.audienceBaseUrl) return { valid: false, error: "Assertion audience mismatch" };
  if (payload.issuedAt !== params.issuedAt || payload.expiresAt !== params.expiresAt) {
    return { valid: false, error: "Assertion timestamps mismatch" };
  }
  const now = Date.now();
  const issuedAt = new Date(payload.issuedAt).getTime();
  const expiresAt = new Date(payload.expiresAt).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, error: "Invalid assertion timestamps" };
  }
  if (issuedAt > now + 60_000) return { valid: false, error: "Assertion issued in the future" };
  if (expiresAt <= now) return { valid: false, error: "Assertion expired" };
  return { valid: true, payload };
}

export function createRemoteViewerToken(params: {
  actorId: string;
  homeBaseUrl: string;
  localInstanceId: string;
  persona?: FederatedAssertionPersonaContext;
  ttlMs?: number;
}): string {
  const now = Date.now();
  const payload: RemoteViewerSessionPayload = {
    type: REMOTE_VIEWER_TOKEN_TYPE,
    actorId: params.actorId,
    homeBaseUrl: params.homeBaseUrl,
    localInstanceId: params.localInstanceId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (params.ttlMs ?? REMOTE_VIEWER_TTL_MS)).toISOString(),
    nonce: randomUUID(),
    ...(params.persona ? { persona: params.persona } : {}),
  };
  return signPackedPayload(payload as unknown as Record<string, unknown>);
}

export function validateRemoteViewerToken(
  token: string,
  localInstanceId: string,
): RemoteViewerSessionPayload | null {
  const payload = verifyPackedPayload<RemoteViewerSessionPayload>(token);
  if (!payload) return null;
  if (payload.type !== REMOTE_VIEWER_TOKEN_TYPE) return null;
  if (payload.localInstanceId !== localInstanceId) return null;
  const expiresAt = new Date(payload.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return payload;
}
