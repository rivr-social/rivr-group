/**
 * Central transactional mailer (#103, refined in #106 — per-kind routing).
 *
 * This is the single place the app decides HOW to deliver an email.
 *
 * On the global/hosted instance (`INSTANCE_TYPE=global`):
 *   - All messages ship via the local SMTP transport in `@/lib/email`.
 *
 * On a peer instance (person/group/locale/region) the routing is
 * per-kind:
 *   - Federated-auth kinds (`verification`, `password-reset`,
 *     `recovery`) are ALWAYS delegated to the global identity
 *     authority's `/api/federation/email/send` endpoint. The peer
 *     cannot override this — federated auth lives on global so the
 *     "lost your password" flow works even if the peer's own SMTP is
 *     misconfigured, credentials were rotated, or the peer is offline.
 *   - Other transactional kinds (`transactional`) use the peer's own
 *     outgoing SMTP config from `peer_smtp_config` when enabled. If
 *     no peer config exists, we fall through to the global relay.
 *
 * Call sites should never import `sendEmail` from `@/lib/email`
 * directly for transactional messages — they go through
 * {@link sendTransactionalEmail} with an explicit `kind`.
 *
 * Key exports:
 * - {@link sendTransactionalEmail}
 * - {@link sendBulkTransactionalEmail}
 * - {@link FEDERATED_AUTH_EMAIL_KINDS}
 * - {@link TransactionalEmailKind}
 * - {@link TransactionalEmailParams}
 * - {@link TransactionalEmailResult}
 *
 * Dependencies:
 * - `@/lib/email` — local SMTP transport (used on global).
 * - `@/lib/federation/email-relay` — signed relay client.
 * - `@/lib/federation/peer-smtp` — per-instance SMTP config loader.
 * - `@/lib/federation/peer-smtp-transport` — peer nodemailer wrapper.
 * - `@/lib/federation/instance-config` — peer vs global detection.
 */

import { sendEmail, type SendEmailResult } from "@/lib/email";
import {
  EMAIL_RELAY_KINDS,
  EmailRelayError,
  sendEmailViaGlobal,
  type EmailRelayKind,
} from "@/lib/federation/email-relay";
import {
  getGlobalIdentityAuthorityUrl,
  getInstanceConfig,
  isPeerInstance,
  shouldDelegateEmail,
  warnIfPeerMissingGlobalEmailAuthority,
} from "@/lib/federation/instance-config";
import {
  getPeerSmtpConfig,
  type PeerSmtpConfig,
} from "@/lib/federation/peer-smtp";
import { sendViaPeerSmtp } from "@/lib/federation/peer-smtp-transport";

/**
 * Transactional kinds that represent federated-auth flows. These
 * ALWAYS route through the global identity authority on a peer —
 * they can never be captured by peer SMTP config. See module docstring.
 */
export const FEDERATED_AUTH_EMAIL_KINDS = [
  EMAIL_RELAY_KINDS.VERIFICATION,
  EMAIL_RELAY_KINDS.PASSWORD_RESET,
  EMAIL_RELAY_KINDS.RECOVERY,
] as const satisfies readonly EmailRelayKind[];

const FEDERATED_AUTH_EMAIL_KIND_SET: ReadonlySet<EmailRelayKind> = new Set(
  FEDERATED_AUTH_EMAIL_KINDS,
);

/**
 * Whether a given kind MUST route through global regardless of any
 * peer SMTP configuration.
 *
 * @param kind Transactional classification.
 * @returns True when global is the only acceptable transport.
 */
export function isFederatedAuthEmailKind(kind: EmailRelayKind): boolean {
  return FEDERATED_AUTH_EMAIL_KIND_SET.has(kind);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Classification of a transactional email. Callers MUST pass an
 * explicit kind so the global relay can route, rate-limit, and log
 * correctly. See `EMAIL_RELAY_KINDS` for the canonical set.
 */
export type TransactionalEmailKind = EmailRelayKind;

/**
 * Parameters accepted by the central mailer. Mirrors
 * {@link SendEmailOptions} but REQUIRES a `kind` and accepts an
 * optional `recipientAgentId` for relay audit provenance.
 */
export interface TransactionalEmailParams {
  /** Transactional classification — verification, password-reset, etc. */
  kind: TransactionalEmailKind;
  /** Recipient email address. */
  to: string;
  /** Subject line. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Optional plaintext body. */
  text?: string;
  /** Optional Reply-To (local SMTP only). */
  replyTo?: string;
  /** Optional recipient agent id — propagated to relay for audit. */
  recipientAgentId?: string;
  /** Optional free-form metadata — propagated to relay for audit. */
  meta?: Record<string, unknown>;
}

/**
 * Result of a transactional send. The shape matches
 * {@link SendEmailResult} across both transports so call sites don't
 * need to branch on delivery path. `delegated` tells callers which
 * transport was actually used (useful for logs + debugging).
 */
export interface TransactionalEmailResult {
  /** Whether delivery succeeded at the chosen transport. */
  success: boolean;
  /** Provider or relay-assigned message id when available. */
  messageId?: string;
  /** Error description when delivery failed. */
  error?: string;
  /** True when the message was handed to the global relay. */
  delegated: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toResultFromLocal(
  local: SendEmailResult,
): TransactionalEmailResult {
  return {
    success: local.success,
    messageId: local.messageId,
    error: local.error,
    delegated: false,
  };
}

/**
 * Derive a plaintext fallback when only HTML is provided. The
 * federation relay prefers a real textBody because global re-renders
 * HTML deterministically from it. Callers that already passed `text`
 * are unchanged.
 */
function derivePlaintext(params: TransactionalEmailParams): string {
  if (params.text && params.text.length > 0) return params.text;
  // Strip tags in a naive but predictable way — this only runs on the
  // peer path and the global log will include both bodies.
  return params.html.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a transactional email.
 *
 * Routing:
 * - Global instance: delivers via local SMTP.
 * - Peer + federated-auth kind (verification/password-reset/recovery):
 *   always delegates to the global relay, regardless of peer SMTP.
 * - Peer + non-federated-auth kind + peer SMTP configured + enabled:
 *   sends via the peer's own SMTP transport.
 * - Peer + non-federated-auth kind + no peer SMTP: falls through to
 *   the global relay.
 *
 * All paths swallow transport errors into `{ success: false, error }`
 * so signup/password-reset/billing flows don't crash when email is
 * temporarily broken.
 *
 * @param params Message + kind.
 * @returns Result carrying the chosen transport outcome.
 */
export async function sendTransactionalEmail(
  params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
  // Peer with no GLOBAL_IDENTITY_AUTHORITY_URL configured — warn once.
  // Federated-auth sends will still attempt the relay path and fail
  // with a clear error rather than silently succeed.
  warnIfPeerMissingGlobalEmailAuthority();

  // On global, nothing to switch on — local SMTP is authoritative.
  if (!isPeerInstance()) {
    return deliverViaLocal(params);
  }

  // Peer path: federated-auth kinds always route to global relay.
  if (isFederatedAuthEmailKind(params.kind)) {
    if (shouldDelegateEmail()) {
      return deliverViaRelay(params);
    }
    // Peer is missing GLOBAL_IDENTITY_AUTHORITY_URL — the warning above
    // already explained this. Fall back to local SMTP so the caller at
    // least gets a deterministic failure (most peer containers have no
    // working SMTP) instead of silently dropping the message.
    return deliverViaLocal(params);
  }

  // Peer + non-federated-auth kind — prefer peer's own SMTP config,
  // otherwise relay via global.
  const peerConfig = await loadPeerSmtpConfigSafe();
  if (peerConfig) {
    return deliverViaPeerSmtp(peerConfig, params);
  }

  if (shouldDelegateEmail()) {
    return deliverViaRelay(params);
  }

  return deliverViaLocal(params);
}

/**
 * Wrap `getPeerSmtpConfig()` so a transient DB error (e.g. the peer
 * just booted before Postgres is ready) does not crash the caller —
 * the mailer falls through to the relay path and logs the failure.
 */
async function loadPeerSmtpConfigSafe(): Promise<PeerSmtpConfig | null> {
  try {
    return await getPeerSmtpConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[mailer] Could not load peer SMTP config, falling back to relay: ${message}`,
    );
    return null;
  }
}

async function deliverViaPeerSmtp(
  config: PeerSmtpConfig,
  params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
  const local = await sendViaPeerSmtp(config, {
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  });
  // delegated=false — the peer handled delivery itself, even though it
  // wasn't the global SMTP transport. Logs treat these two local paths
  // uniformly.
  return toResultFromLocal(local);
}

async function deliverViaLocal(
  params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
  const local = await sendEmail({
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  });
  return toResultFromLocal(local);
}

async function deliverViaRelay(
  params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
  const globalBaseUrl = getGlobalIdentityAuthorityUrl();
  // shouldDelegateEmail() already confirmed this is non-null, but we
  // re-check so a concurrent env mutation surfaces as a typed error
  // rather than an undefined deref.
  if (!globalBaseUrl) {
    return {
      success: false,
      error: "GLOBAL_IDENTITY_AUTHORITY_URL is not configured",
      delegated: true,
    };
  }

  const config = getInstanceConfig();

  try {
    const response = await sendEmailViaGlobal({
      globalBaseUrl,
      kind: params.kind,
      peerBaseUrl: config.baseUrl,
      recipientEmail: params.to,
      recipientAgentId: params.recipientAgentId,
      subject: params.subject,
      textBody: derivePlaintext(params),
      htmlBody: params.html,
      meta: params.meta,
    });

    if (response.ok) {
      return {
        success: true,
        messageId: response.messageId,
        delegated: true,
      };
    }

    return {
      success: false,
      error: `${response.code}: ${response.error}`,
      delegated: true,
    };
  } catch (error) {
    // EmailRelayError carries a stable `code` (local_node_missing,
    // retries_exhausted, etc.); preserve it so logs stay actionable
    // without crashing the caller's flow (e.g., signup must still
    // complete when relay is temporarily unreachable).
    const message =
      error instanceof EmailRelayError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(
      `[mailer] Relay delivery failed (kind=${params.kind}, to=${params.to}): ${message}`,
    );
    return {
      success: false,
      error: message,
      delegated: true,
    };
  }
}

/**
 * Batch variant of {@link sendTransactionalEmail} that preserves the
 * per-recipient Map result shape previously returned by
 * `sendBulkEmail`. Each recipient goes through the same transport
 * decision logic, so peers relay each message individually (letting
 * the global relay enforce its own rate limiting + signature audit).
 *
 * Iterates in small pool-sized batches to bound concurrency regardless
 * of transport — the peer path can't rely on Nodemailer pooling.
 *
 * @param recipients List of recipient email addresses.
 * @param params Shared message fields (kind, subject, html, etc.).
 * @returns Map keyed by recipient email → per-recipient result.
 */
export async function sendBulkTransactionalEmail(
  recipients: string[],
  params: Omit<TransactionalEmailParams, "to" | "recipientAgentId"> & {
    agentIdFor?: (email: string) => string | undefined;
  },
): Promise<Map<string, TransactionalEmailResult>> {
  const results = new Map<string, TransactionalEmailResult>();
  const BATCH_SIZE = 5;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((to) => {
        const { agentIdFor, ...rest } = params;
        return sendTransactionalEmail({
          ...rest,
          to,
          recipientAgentId: agentIdFor?.(to),
        });
      }),
    );
    batchResults.forEach((result, idx) => {
      const recipient = batch[idx];
      if (result.status === "fulfilled") {
        results.set(recipient, result.value);
      } else {
        results.set(recipient, {
          success: false,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason ?? "Unknown error"),
          delegated: shouldDelegateEmail(),
        });
      }
    });
  }

  return results;
}

/**
 * Re-export of the canonical kind catalog so call sites can import
 * both the abstraction and the kind constants from a single module.
 */
export { EMAIL_RELAY_KINDS as TRANSACTIONAL_EMAIL_KINDS };
