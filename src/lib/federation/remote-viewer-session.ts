// src/lib/federation/remote-viewer-session.ts

/**
 * Remote-viewer session cookie helpers for federated-SSO login (issue #102).
 *
 * Purpose:
 * - Encapsulate the signed, short-lived session cookie (`rivr_remote_viewer`)
 *   that a peer instance sets after accepting an SSO assertion from the
 *   global identity authority.
 * - Keep the remote-viewer session isolated from NextAuth's own session so
 *   the two can coexist during the migration from local-credentials-only
 *   auth to federated-SSO auth.
 *
 * Key exports:
 * - {@link REMOTE_VIEWER_COOKIE_NAME}
 * - {@link REMOTE_VIEWER_DEFAULT_LIFETIME_SEC}
 * - {@link RemoteViewerSessionPayload}
 * - {@link RemoteViewerAuthMethod}
 * - {@link encodeRemoteViewerSession}
 * - {@link decodeRemoteViewerSession}
 * - {@link RemoteViewerSessionError}
 *
 * Security properties:
 * - Payload is HMAC-SHA256 signed with `AUTH_SECRET`. An attacker that
 *   cannot read the process env cannot mint a valid cookie.
 * - Embedded `exp` is enforced on decode so stolen cookies rot on their
 *   own even without server-side revocation.
 * - Constant-time signature comparison to prevent timing oracles.
 * - `payload.authMethod` is carried in the signed surface so downstream
 *   consumers can gate sensitive writes on the authentication mode.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// Re-export shared value + type surface from the types module so edge
// middleware can import cookie name + payload shape without being forced
// to transitively pull `node:crypto` into the edge bundle.
export {
  REMOTE_VIEWER_COOKIE_NAME,
  type RemoteViewerAuthMethod,
  type RemoteViewerSessionPayload,
} from "./remote-viewer-session-types";

import type { RemoteViewerSessionPayload } from "./remote-viewer-session-types";

/** Default cookie lifetime: 7 days (parity with NextAuth JWT session). */
export const REMOTE_VIEWER_DEFAULT_LIFETIME_SEC = 7 * 24 * 60 * 60;

/** Maximum cookie lifetime allowed — hard ceiling for `encode`. */
export const REMOTE_VIEWER_MAX_LIFETIME_SEC = 30 * 24 * 60 * 60;

/** Thrown when a cookie cannot be decoded, verified, or has expired. */
export class RemoteViewerSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteViewerSessionError";
  }
}

/** Input accepted by {@link encodeRemoteViewerSession}. */
export interface EncodeRemoteViewerInput
  extends Omit<RemoteViewerSessionPayload, "iat" | "exp"> {
  /** Optional lifetime override, clamped to `[1, MAX]`. */
  lifetimeSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
}

/**
 * Encode and sign a remote-viewer session payload.
 *
 * Format: `${base64url(payloadJson)}.${base64url(hmacSha256(payloadJson, secret))}`
 *
 * @param input Payload plus optional clock/lifetime overrides.
 * @param secret HMAC signing secret — typically `process.env.AUTH_SECRET`.
 * @returns Opaque cookie value ready to set on `Set-Cookie`.
 * @throws {RemoteViewerSessionError} Invalid input or missing secret.
 */
export function encodeRemoteViewerSession(
  input: EncodeRemoteViewerInput,
  secret: string,
): string {
  if (!secret) {
    throw new RemoteViewerSessionError("HMAC secret is required");
  }
  validateEncodeInput(input);

  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const lifetimeSec = clampLifetime(input.lifetimeSec);
  const exp = iat + lifetimeSec;

  const payload: RemoteViewerSessionPayload = {
    actorId: input.actorId,
    homeBaseUrl: input.homeBaseUrl,
    globalIssuerBaseUrl: input.globalIssuerBaseUrl,
    credentialVersion: input.credentialVersion,
    homeAuthorityVersion: input.homeAuthorityVersion,
    instanceClass: input.instanceClass,
    parentAgentId: input.parentAgentId,
    authMethod: input.authMethod,
    iat,
    exp,
  };

  const json = JSON.stringify(payload);
  const body = toBase64Url(Buffer.from(json, "utf8"));
  const sig = toBase64Url(hmac(json, secret));
  return `${body}.${sig}`;
}

/**
 * Decode and verify a remote-viewer session cookie.
 *
 * @param cookieValue Raw cookie value (may be `undefined` for missing cookie).
 * @param secret HMAC signing secret — must match what encoded the cookie.
 * @param now Optional fixed clock for tests (milliseconds since epoch).
 * @returns The verified payload, or `null` when the cookie is missing or
 *   fails verification/expiry.
 */
export function decodeRemoteViewerSession(
  cookieValue: string | undefined | null,
  secret: string,
  now?: number,
): RemoteViewerSessionPayload | null {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  let jsonBuf: Buffer;
  try {
    jsonBuf = fromBase64Url(body);
  } catch {
    return null;
  }
  const json = jsonBuf.toString("utf8");

  const expectedSig = hmac(json, secret);
  let providedSig: Buffer;
  try {
    providedSig = fromBase64Url(sig);
  } catch {
    return null;
  }
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRemoteViewerPayload(parsed)) return null;

  const nowSec = Math.floor((typeof now === "number" ? now : Date.now()) / 1000);
  if (parsed.exp <= nowSec) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateEncodeInput(input: EncodeRemoteViewerInput): void {
  if (!input.actorId) {
    throw new RemoteViewerSessionError("actorId is required");
  }
  if (!input.homeBaseUrl) {
    throw new RemoteViewerSessionError("homeBaseUrl is required");
  }
  if (
    input.authMethod !== "federated-sso" &&
    input.authMethod !== "home-assertion" &&
    input.authMethod !== "local-credentials"
  ) {
    throw new RemoteViewerSessionError(
      `authMethod must be federated-sso|home-assertion|local-credentials; got ${String(input.authMethod)}`,
    );
  }
  if (input.authMethod === "federated-sso" && !input.globalIssuerBaseUrl) {
    throw new RemoteViewerSessionError(
      "globalIssuerBaseUrl is required when authMethod is federated-sso",
    );
  }
  if (!Number.isInteger(input.credentialVersion) || input.credentialVersion < 1) {
    throw new RemoteViewerSessionError(
      `credentialVersion must be a positive integer; got ${input.credentialVersion}`,
    );
  }
  if (
    !Number.isInteger(input.homeAuthorityVersion) ||
    input.homeAuthorityVersion < 1
  ) {
    throw new RemoteViewerSessionError(
      `homeAuthorityVersion must be a positive integer; got ${input.homeAuthorityVersion}`,
    );
  }
  if (
    input.instanceClass !== "hosted-federated" &&
    input.instanceClass !== "sovereign"
  ) {
    throw new RemoteViewerSessionError(
      `instanceClass must be hosted-federated|sovereign; got ${String(input.instanceClass)}`,
    );
  }
}

function clampLifetime(requested: number | undefined): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return REMOTE_VIEWER_DEFAULT_LIFETIME_SEC;
  }
  return Math.min(Math.floor(requested), REMOTE_VIEWER_MAX_LIFETIME_SEC);
}

function hmac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const padLen = (4 - (input.length % 4)) % 4;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return Buffer.from(normalized, "base64");
}

function isRemoteViewerPayload(v: unknown): v is RemoteViewerSessionPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.actorId === "string" &&
    typeof o.homeBaseUrl === "string" &&
    (o.globalIssuerBaseUrl === null || typeof o.globalIssuerBaseUrl === "string") &&
    typeof o.credentialVersion === "number" &&
    typeof o.homeAuthorityVersion === "number" &&
    (o.instanceClass === "hosted-federated" || o.instanceClass === "sovereign") &&
    (o.parentAgentId === null || typeof o.parentAgentId === "string") &&
    (o.authMethod === "federated-sso" ||
      o.authMethod === "home-assertion" ||
      o.authMethod === "local-credentials") &&
    typeof o.iat === "number" &&
    typeof o.exp === "number"
  );
}
