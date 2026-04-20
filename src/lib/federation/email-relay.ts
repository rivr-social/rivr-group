// src/lib/federation/email-relay.ts

import { db } from "@/db";
import { nodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { canonicalize, signPayload } from "@/lib/federation-crypto";
import { getInstanceConfig } from "./instance-config";

/**
 * Federation email relay client primitives (issue #101).
 *
 * Purpose:
 * - Let a peer Rivr instance delegate outbound transactional email to
 *   the global instance (which runs the only known-good Gmail SMTP
 *   transport) instead of each peer maintaining its own SMTP creds.
 * - Sign the relay request with the calling instance's Ed25519 node
 *   private key using the *same* canonicalization rules used by
 *   `authority-events.ts` / `federation-crypto.ts`, so the receiving
 *   global can verify the sender against the `nodes.public_key` it
 *   already has on file.
 * - Provide a tightly scoped retry policy for 5xx responses without
 *   accidentally retrying client-side validation failures (4xx).
 *
 * Key exports:
 * - {@link EMAIL_RELAY_KINDS}
 * - {@link EmailRelayKind}
 * - {@link EmailRelayHeader}
 * - {@link EmailRelayRequestBody}
 * - {@link EmailRelayResponse}
 * - {@link canonicalizeEmailRelayBody}
 * - {@link sendEmailViaGlobal}
 * - {@link EmailRelayError}
 *
 * Dependencies:
 * - `@/lib/federation-crypto` — Ed25519 sign + canonical JSON.
 * - `@/db` + `nodes` for resolving the local signing key.
 * - `getInstanceConfig()` for the caller's instance id / base url.
 *
 * Why a helper (not just inline fetch):
 * - Peer repos (spirit, mutual-aid-boulder, etc.) will copy this helper
 *   verbatim as their reference implementation. Keeping it in
 *   `rivr-monorepo` first makes it a shared contract that we can
 *   evolve + keep in lockstep with the server route.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical catalog of relay email "kinds". Limiting the accepted set
 * keeps a compromised peer from abusing global SMTP to send arbitrary
 * marketing / spam under the platform's reputation — every accepted
 * kind must map to a transactional, user-expected message.
 */
export const EMAIL_RELAY_KINDS = {
  VERIFICATION: "verification",
  PASSWORD_RESET: "password-reset",
  RECOVERY: "recovery",
  TRANSACTIONAL: "transactional",
} as const;

export type EmailRelayKind =
  (typeof EMAIL_RELAY_KINDS)[keyof typeof EMAIL_RELAY_KINDS];

/** All accepted kinds as a Set for O(1) membership checks. */
export const EMAIL_RELAY_KIND_SET = new Set<string>(
  Object.values(EMAIL_RELAY_KINDS),
);

/** HTTP header names shared between the relay client and the route. */
export const EmailRelayHeader = {
  SIGNATURE: "x-rivr-federation-signature",
  NODE: "x-rivr-federation-node",
} as const;

/** Default number of HTTP attempts (1 initial + 2 retries). */
export const EMAIL_RELAY_MAX_ATTEMPTS = 3;

/** Base backoff between retries (ms). Doubles each attempt. */
export const EMAIL_RELAY_BASE_BACKOFF_MS = 250;

/** Per-request timeout. Caps how long a single HTTP attempt can hang. */
export const EMAIL_RELAY_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Request body POSTed to `/api/federation/email/send` on the global.
 * The body is canonicalized (via {@link canonicalizeEmailRelayBody}) and
 * Ed25519-signed with the peer's node private key; the signature is
 * carried in the `X-Rivr-Federation-Signature` header.
 *
 * The signed surface intentionally covers every field that affects
 * delivery (kind, recipient, body, meta) so a MITM can't mutate the
 * message without breaking the signature.
 */
export interface EmailRelayRequestBody {
  /** Classification of the message — see {@link EMAIL_RELAY_KINDS}. */
  kind: EmailRelayKind;
  /** Base URL of the peer asking global to send this message. */
  peerBaseUrl: string;
  /** Instance UUID of the peer (must match a `nodes.id` on global). */
  peerInstanceId: string;
  /** Optional peer-side agent context for audit provenance. */
  peerAgentId?: string;
  /** Recipient email address. */
  recipientEmail: string;
  /** Optional recipient agent id (if known on the peer). */
  recipientAgentId?: string;
  /** Subject line. */
  subject: string;
  /** Plaintext body. */
  textBody: string;
  /** Optional HTML body. */
  htmlBody?: string;
  /** ISO-8601 UTC issuance timestamp. Covers replay protection. */
  issuedAt: string;
  /** Free-form metadata persisted to `email_log.metadata`. */
  meta?: Record<string, unknown>;
}

/** Successful relay response shape. */
export interface EmailRelayOkResponse {
  ok: true;
  messageId?: string;
  emailLogId: string;
}

/** Failed relay response shape (4xx/5xx). */
export interface EmailRelayErrorResponse {
  ok: false;
  error: string;
  code: string;
}

export type EmailRelayResponse = EmailRelayOkResponse | EmailRelayErrorResponse;

/**
 * Error thrown when the relay client cannot complete the call (can't
 * sign, transport exhausted, malformed response, etc.). Separate type
 * so callers can distinguish a definite failure from an "in-progress"
 * retry.
 */
export class EmailRelayError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "EmailRelayError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSON string that gets signed + verified. Callers
 * on both ends MUST use this exact helper — field order, inclusion
 * rules, and `undefined` stripping are part of the signed contract.
 *
 * @param body The full relay body.
 * @returns Canonical JSON string (RFC 8785 style).
 */
export function canonicalizeEmailRelayBody(body: EmailRelayRequestBody): string {
  return canonicalize({
    htmlBody: body.htmlBody,
    issuedAt: body.issuedAt,
    kind: body.kind,
    meta: body.meta,
    peerAgentId: body.peerAgentId,
    peerBaseUrl: body.peerBaseUrl,
    peerInstanceId: body.peerInstanceId,
    recipientAgentId: body.recipientAgentId,
    recipientEmail: body.recipientEmail,
    subject: body.subject,
    textBody: body.textBody,
  });
}

// ---------------------------------------------------------------------------
// Private key loading
// ---------------------------------------------------------------------------

/**
 * Resolve the calling instance's Ed25519 private key from `nodes`.
 * Throws {@link EmailRelayError} with a stable `code` so callers and
 * logs always get a consistent failure classification.
 */
async function loadLocalPrivateKey(): Promise<{
  privateKey: string;
  instanceId: string;
}> {
  const config = getInstanceConfig();
  const row = await db
    .select({ privateKey: nodes.privateKey })
    .from(nodes)
    .where(eq(nodes.id, config.instanceId))
    .limit(1);
  if (row.length === 0) {
    throw new EmailRelayError(
      `Local node ${config.instanceId} is not registered; cannot sign email relay requests`,
      "local_node_missing",
    );
  }
  const privateKey = row[0].privateKey;
  if (!privateKey) {
    throw new EmailRelayError(
      `Local node ${config.instanceId} has no private key; cannot sign email relay requests`,
      "local_private_key_missing",
    );
  }
  return { privateKey, instanceId: config.instanceId };
}

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendEmailViaGlobalParams {
  /** Absolute base URL of the global receiver, e.g. `https://a.rivr.social`. */
  globalBaseUrl: string;
  /** One of {@link EMAIL_RELAY_KINDS}. */
  kind: EmailRelayKind;
  /** This peer's base URL — echoed for audit/provenance. */
  peerBaseUrl: string;
  /** Optional peer-side agent context for audit. */
  peerAgentId?: string;
  /** Recipient email. */
  recipientEmail: string;
  /** Optional recipient agent id known to the peer. */
  recipientAgentId?: string;
  /** Subject. */
  subject: string;
  /** Plaintext body. */
  textBody: string;
  /** Optional HTML body. */
  htmlBody?: string;
  /** Free-form audit metadata. */
  meta?: Record<string, unknown>;
  /** Override for the ISO timestamp (testing). Defaults to `new Date().toISOString()`. */
  issuedAt?: string;
  /** Override max attempts for the retry loop (testing). */
  maxAttempts?: number;
  /** Override backoff delay (testing). Seeds attempt 0. */
  baseBackoffMs?: number;
  /** Replace the fetch implementation (testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Sign + POST an email relay request to global's
 * `/api/federation/email/send`. Retries on 5xx with exponential backoff
 * up to {@link EMAIL_RELAY_MAX_ATTEMPTS}. Never retries 4xx — those are
 * the peer's own fault (bad signature, unknown peer, malformed body),
 * so retrying only adds pointless load.
 *
 * @param params Relay parameters.
 * @returns The JSON body the server returned, typed as
 *   {@link EmailRelayResponse}.
 * @throws {EmailRelayError} If signing fails or all attempts exhaust.
 */
export async function sendEmailViaGlobal(
  params: SendEmailViaGlobalParams,
): Promise<EmailRelayResponse> {
  if (!EMAIL_RELAY_KIND_SET.has(params.kind)) {
    throw new EmailRelayError(
      `Unknown email relay kind: ${params.kind}`,
      "invalid_kind",
    );
  }
  if (!params.globalBaseUrl) {
    throw new EmailRelayError(
      "globalBaseUrl is required",
      "missing_global_base_url",
    );
  }

  const { privateKey, instanceId } = await loadLocalPrivateKey();

  const body: EmailRelayRequestBody = {
    kind: params.kind,
    peerBaseUrl: params.peerBaseUrl,
    peerInstanceId: instanceId,
    peerAgentId: params.peerAgentId,
    recipientEmail: params.recipientEmail,
    recipientAgentId: params.recipientAgentId,
    subject: params.subject,
    textBody: params.textBody,
    htmlBody: params.htmlBody,
    issuedAt: params.issuedAt ?? new Date().toISOString(),
    meta: params.meta,
  };

  // Sign the canonicalized body using the existing federation-crypto
  // signer. `signPayload` re-canonicalizes internally, so we pass the
  // same signed surface the receiver will canonicalize + verify.
  const signedSurface = {
    htmlBody: body.htmlBody,
    issuedAt: body.issuedAt,
    kind: body.kind,
    meta: body.meta,
    peerAgentId: body.peerAgentId,
    peerBaseUrl: body.peerBaseUrl,
    peerInstanceId: body.peerInstanceId,
    recipientAgentId: body.recipientAgentId,
    recipientEmail: body.recipientEmail,
    subject: body.subject,
    textBody: body.textBody,
  };
  const signature = signPayload(signedSurface, privateKey);

  const url = `${params.globalBaseUrl.replace(/\/$/, "")}/api/federation/email/send`;
  const maxAttempts = Math.max(1, params.maxAttempts ?? EMAIL_RELAY_MAX_ATTEMPTS);
  const baseBackoff = params.baseBackoffMs ?? EMAIL_RELAY_BASE_BACKOFF_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  let lastError: string = "unknown";
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      // Exponential: baseBackoff, 2×baseBackoff, 4×baseBackoff…
      await delay(baseBackoff * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      EMAIL_RELAY_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EmailRelayHeader.SIGNATURE]: signature,
          [EmailRelayHeader.NODE]: instanceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      lastStatus = response.status;

      // 5xx → eligible for retry. 4xx → final failure (don't retry).
      if (response.status >= 500) {
        const errText = await response.text().catch(() => "");
        lastError = `server_error ${response.status}${errText ? `: ${errText.slice(0, 512)}` : ""}`;
        continue;
      }

      let parsed: EmailRelayResponse;
      try {
        parsed = (await response.json()) as EmailRelayResponse;
      } catch {
        throw new EmailRelayError(
          `Relay returned non-JSON body (status ${response.status})`,
          "bad_response_body",
          response.status,
        );
      }

      return parsed;
    } catch (error) {
      // Network / timeout / AbortError path — treat as transient.
      if (error instanceof EmailRelayError) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new EmailRelayError(
    `Email relay exhausted ${maxAttempts} attempts: ${lastError}`,
    "retries_exhausted",
    lastStatus,
  );
}

