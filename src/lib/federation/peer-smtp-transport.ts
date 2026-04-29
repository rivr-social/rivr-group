/**
 * Peer outgoing SMTP transport (ticket #106).
 *
 * Thin nodemailer wrapper that sends an email using the peer's own
 * configured SMTP credentials (from `peer_smtp_config`). Exposes the
 * same interface shape as `@/lib/email`.sendEmail so the central mailer
 * can pick a transport with one conditional.
 *
 * A per-config transporter cache keeps connection pooling efficient:
 * if the admin rotates credentials, {@link resetPeerSmtpTransportCache}
 * (called after admin write) drops the old transport so the next send
 * rebuilds with fresh settings.
 *
 * Security note:
 * - The resolved password lives in-process only — it is attached to
 *   the nodemailer transport and never logged or echoed in results.
 *
 * Key exports:
 * - {@link sendViaPeerSmtp}
 * - {@link resetPeerSmtpTransportCache}
 * - {@link verifyPeerSmtpConfig}
 *
 * Dependencies:
 * - `nodemailer`
 * - `@/lib/federation/peer-smtp` for resolved config
 */

import nodemailer, { type Transporter } from "nodemailer";
import type { SendEmailOptions, SendEmailResult } from "@/lib/email";
import {
  type PeerSmtpConfig,
} from "./peer-smtp";

/** Gmail submission host used for Workspace XOAUTH2 sends. */
const GMAIL_SMTP_HOST = "smtp.gmail.com";
/** Implicit-TLS port (`secure: true`) used for Gmail XOAUTH2 sends. */
const GMAIL_SMTP_PORT = 465;

/** Pool size cap for peer SMTP transports (matches the global mailer). */
const PEER_TRANSPORT_POOL_SIZE = 5;
/** Rate limit (messages/sec) matching global mailer. */
const PEER_TRANSPORT_RATE_LIMIT = 10;

interface CachedTransporter {
  /** Fingerprint of the config that built this transport. */
  fingerprint: string;
  transport: Transporter;
}

let _transporterCache: CachedTransporter | null = null;

/**
 * Compute a stable fingerprint for a config so we can detect when the
 * admin changed credentials and rebuild the transporter. Includes the
 * resolved password in the hash so a rotated secret also invalidates
 * the pooled transport.
 */
function fingerprintConfig(config: PeerSmtpConfig): string {
  return [
    config.host,
    String(config.port),
    config.secure ? "secure" : "starttls",
    config.username,
    config.fromAddress,
    // Fingerprint the password length + last 4 chars to detect rotations
    // without ever writing the password value itself to a log or error.
    `pwlen:${config.password.length}:${config.password.slice(-4)}`,
  ].join("|");
}

function getTransporter(config: PeerSmtpConfig): Transporter {
  const fingerprint = fingerprintConfig(config);
  if (_transporterCache && _transporterCache.fingerprint === fingerprint) {
    return _transporterCache.transport;
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    pool: true,
    maxConnections: PEER_TRANSPORT_POOL_SIZE,
    rateDelta: 1000,
    rateLimit: PEER_TRANSPORT_RATE_LIMIT,
    auth: {
      user: config.username,
      pass: config.password,
    },
  });

  _transporterCache = { fingerprint, transport };
  return transport;
}

/**
 * Clear the cached transporter. Admin writes to `peer_smtp_config`
 * must call this so the next send rebuilds with fresh auth.
 *
 * @returns Nothing.
 */
export function resetPeerSmtpTransportCache(): void {
  if (_transporterCache?.transport) {
    _transporterCache.transport.close();
  }
  _transporterCache = null;
}

/**
 * Send a single transactional email via the peer's own SMTP transport.
 *
 * The result shape matches `@/lib/email`.SendEmailResult so call sites
 * in the central mailer don't need to branch on transport.
 *
 * @param config Resolved peer SMTP config (from `getPeerSmtpConfig`).
 * @param options Recipient / subject / body envelope.
 * @returns Structured result: `{ success, messageId?, error? }`.
 */
export async function sendViaPeerSmtp(
  config: PeerSmtpConfig,
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const transport = getTransporter(config);
  try {
    const info = await transport.sendMail({
      from: config.fromAddress,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[peer-smtp] Send failed to=${options.to} host=${config.host}: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Verify a peer SMTP config by performing a transporter handshake +
 * optional test send. Used by the admin API `/api/admin/smtp-config/test`
 * to give operators immediate feedback.
 *
 * @param config Resolved config.
 * @param testRecipient Optional recipient for a test message. When
 *   provided, actually sends a short test email; otherwise only calls
 *   `transporter.verify()`.
 * @returns Structured result with verification + optional send outcome.
 */
export async function verifyPeerSmtpConfig(
  config: PeerSmtpConfig,
  testRecipient?: string,
): Promise<SendEmailResult> {
  const transport = getTransporter(config);
  try {
    await transport.verify();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `verify: ${message}` };
  }

  if (!testRecipient) {
    return { success: true };
  }

  return sendViaPeerSmtp(config, {
    to: testRecipient,
    subject: "Rivr peer SMTP test",
    html:
      `<p>This is an automated test from your Rivr instance confirming ` +
      `that outgoing SMTP is configured correctly.</p>` +
      `<p>Host: <code>${config.host}:${config.port}</code><br>` +
      `From: <code>${config.fromAddress}</code></p>`,
    text:
      `This is an automated test from your Rivr instance confirming ` +
      `that outgoing SMTP is configured correctly.\n\n` +
      `Host: ${config.host}:${config.port}\nFrom: ${config.fromAddress}`,
  });
}

// ---------------------------------------------------------------------------
// XOAUTH2 transporter (Google Workspace per-group connections)
// ---------------------------------------------------------------------------

/** Inputs required to build a Gmail XOAUTH2 transporter for a group. */
export interface BuildXoauth2TransporterInput {
  /** Workspace account email — used as the SMTP user and From address. */
  accountEmail: string;
  /** Live (non-expired) OAuth2 access token. */
  accessToken: string;
  /** Refresh token, when one is on file. Optional. */
  refreshToken?: string | null;
  /** Absolute UTC expiry of the access token, when known. */
  expiresAt?: Date | null;
  /**
   * OAuth2 client id/secret for token refresh inside nodemailer. Optional —
   * if omitted, nodemailer will reject access-token expiry; callers should
   * pre-refresh via `getFreshGoogleAccessToken` before reaching this path.
   */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Build a Gmail XOAUTH2 nodemailer transporter for a group's linked
 * Workspace account. The caller is expected to have already refreshed
 * the access token via `getFreshGoogleAccessToken` so the resulting
 * transporter does not need network access to send.
 *
 * Note: returned transporter is unpooled — the wedge in `mailer.ts`
 * builds a fresh transporter per send so a token rotation never reuses
 * stale credentials. This trades a small connection-setup cost for
 * deterministic correctness.
 *
 * @param input Workspace credentials.
 * @returns A non-pooled nodemailer transporter ready for `sendMail()`.
 */
export function buildXoauth2Transporter(
  input: BuildXoauth2TransporterInput,
): Transporter {
  const expiresMs =
    input.expiresAt instanceof Date ? input.expiresAt.getTime() : undefined;

  return nodemailer.createTransport({
    host: GMAIL_SMTP_HOST,
    port: GMAIL_SMTP_PORT,
    secure: true,
    auth: {
      type: "OAuth2",
      user: input.accountEmail,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? undefined,
      expires: expiresMs,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    },
  });
}

/**
 * Send a single email via a freshly built Gmail XOAUTH2 transporter.
 *
 * The transporter is closed after the send to guarantee a stale
 * access-token never lingers in a pooled connection.
 *
 * @param input Workspace credentials.
 * @param options Recipient/subject/body envelope; mirrors `sendEmail`.
 * @returns Structured result `{ success, messageId?, error? }`.
 */
export async function sendViaXoauth2(
  input: BuildXoauth2TransporterInput,
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const transport = buildXoauth2Transporter(input);
  try {
    const info = await transport.sendMail({
      from: input.accountEmail,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[group-smtp] XOAUTH2 send failed to=${options.to} account=${input.accountEmail}: ${message}`,
    );
    return { success: false, error: message };
  } finally {
    transport.close();
  }
}
