// src/lib/federation/remote-viewer-session-edge.ts

/**
 * Edge-safe remote-viewer session decoder (issue #105).
 *
 * Why this exists:
 * - {@link ./remote-viewer-session.ts} imports `node:crypto`, which is not
 *   available in the Next.js edge runtime where `middleware.ts` runs.
 * - The middleware needs to verify and accept the signed `rivr_remote_viewer`
 *   cookie as an authenticated session, alongside the existing NextAuth JWT.
 * - This module implements the same HMAC-SHA256 verification using the Web
 *   Crypto API (`globalThis.crypto.subtle`), which is available in both the
 *   edge runtime and modern Node runtimes.
 *
 * Security properties (parity with the node module):
 * - Signature verified with HMAC-SHA256 before any payload trust.
 * - Constant-time signature comparison via `crypto.subtle.verify`, which
 *   performs timing-safe equality internally.
 * - Embedded `exp` claim is enforced on decode; expired cookies return null.
 * - Payload shape is validated structurally before return.
 *
 * Non-goals:
 * - Encoding. Edge code should never mint cookies; only the acceptance route
 *   (`/api/federation/remote-auth`) mints, and that route runs on Node.
 */

import type { RemoteViewerSessionPayload } from "./remote-viewer-session-types";

/**
 * Decode and verify a remote-viewer session cookie using Web Crypto.
 *
 * @param cookieValue Raw cookie value (may be undefined/null for missing cookie).
 * @param secret      HMAC signing secret — must match the encoder's secret.
 * @param now         Optional fixed clock for tests (milliseconds since epoch).
 * @returns The verified payload, or `null` when the cookie is missing or
 *          fails verification/expiry.
 */
export async function decodeRemoteViewerSessionEdge(
  cookieValue: string | undefined | null,
  secret: string,
  now?: number,
): Promise<RemoteViewerSessionPayload | null> {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [body, sig] = parts;

  let jsonBytes: Uint8Array;
  try {
    jsonBytes = fromBase64Url(body);
  } catch {
    return null;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return null;
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    valid = await subtle.verify(
      "HMAC",
      key,
      // Copy into a fresh ArrayBuffer so the view's backing buffer is
      // exactly sized (avoids SharedArrayBuffer / offset edge cases).
      toArrayBuffer(sigBytes),
      toArrayBuffer(jsonBytes),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    return null;
  }
  if (!isRemoteViewerPayload(parsed)) return null;

  const nowSec = Math.floor((typeof now === "number" ? now : Date.now()) / 1000);
  if (parsed.exp <= nowSec) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Internal helpers — edge-safe (no node:crypto, no Buffer).
// ---------------------------------------------------------------------------

function fromBase64Url(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const normalized =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  // `atob` is available in edge and modern Node runtimes.
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
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
