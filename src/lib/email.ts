/**
 * Email delivery utilities backed by a singleton Nodemailer SMTP transport.
 *
 * Key exports:
 * - `sendEmail`: sends one message and returns a structured success/error result.
 * - `sendBulkEmail`: sends many messages in connection-sized batches.
 * - `verifyEmailTransport`: checks SMTP readiness for health checks.
 * - `_resetTransporter`: test helper to clear the cached singleton.
 *
 * Dependencies:
 * - `nodemailer` for SMTP transport creation and message dispatch.
 * - `getEnv` from `@/lib/env` for validated environment configuration.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getEnv } from '@/lib/env';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent SMTP connections in the pooled transport. */
const TRANSPORT_POOL_SIZE = 5;
/** Maximum messages allowed per second by Nodemailer rate limiting. */
const TRANSPORT_RATE_LIMIT = 10; // messages per second

// ---------------------------------------------------------------------------
// Transport singleton
// ---------------------------------------------------------------------------

let _transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (_transporter) return _transporter;

  // Credentials and host settings are read once per process and cached via singleton.
  const host = getEnv('SMTP_HOST');
  const port = parseInt(getEnv('SMTP_PORT'), 10);
  const user = getEnv('SMTP_USER');
  const pass = getEnv('SMTP_PASS');
  const secure = getEnv('SMTP_SECURE') === 'true';
  const rejectUnauthorized = getEnv('SMTP_TLS_REJECT_UNAUTHORIZED') !== 'false';

  // Pooling and rate limiting reduce burst load and prevent provider throttling.
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    pool: true,
    maxConnections: TRANSPORT_POOL_SIZE,
    rateDelta: 1000,
    rateLimit: TRANSPORT_RATE_LIMIT,
    tls: {
      rejectUnauthorized,
    },
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  return _transporter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
  /** Recipient email address. */
  to: string;
  /** Subject line displayed in the recipient inbox. */
  subject: string;
  /** HTML body for rich email clients. */
  html: string;
  /** Optional plaintext body for compatibility and accessibility. */
  text?: string;
  /** Optional Reply-To override used by mail clients. */
  replyTo?: string;
}

export interface SendEmailResult {
  /** Indicates whether message dispatch completed successfully. */
  success: boolean;
  /** Provider-assigned message ID when available on success. */
  messageId?: string;
  /** Error description when sending fails. */
  error?: string;
}

/**
 * Sends a single email via the configured SMTP transport.
 *
 * @param options - Message metadata and body content for the outbound email.
 * @returns A structured result with success flag, message ID, or error details.
 * @throws This function does not throw; transport errors are captured and returned.
 * @example
 * ```ts
 * const result = await sendEmail({
 *   to: 'user@example.com',
 *   subject: 'Welcome',
 *   html: '<p>Hello</p>',
 * });
 *
 * if (!result.success) {
 *   console.error(result.error);
 * }
 * ```
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const from = getEnv('SMTP_FROM');
  const transporter = getTransporter();

  try {
    const info = await transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
    });

    return { success: true, messageId: info.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log only routing metadata + message text; avoids logging full HTML payload content.
    console.error(`[email] Failed to send to ${options.to}: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Send emails to multiple recipients in batches.
 * Returns per-recipient results. Does not throw.
 *
 * @param recipients - List of recipient email addresses.
 * @param subject - Shared subject line for all recipients.
 * @param html - Shared HTML body.
 * @param text - Optional shared plaintext fallback.
 * @returns A map keyed by recipient containing individual send results.
 * @throws This function does not throw; rejected sends are converted into failed results.
 * @example
 * ```ts
 * const results = await sendBulkEmail(
 *   ['a@example.com', 'b@example.com'],
 *   'Announcement',
 *   '<p>Important update</p>'
 * );
 *
 * console.log(results.get('a@example.com'));
 * ```
 */
export async function sendBulkEmail(
  recipients: string[],
  subject: string,
  html: string,
  text?: string,
  options?: { replyTo?: string },
): Promise<Map<string, SendEmailResult>> {
  const results = new Map<string, SendEmailResult>();

  // Process in pool-sized batches to align with transport concurrency constraints.
  for (let i = 0; i < recipients.length; i += TRANSPORT_POOL_SIZE) {
    const batch = recipients.slice(i, i + TRANSPORT_POOL_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((to) => sendEmail({ to, subject, html, text, replyTo: options?.replyTo }))
    );

    batchResults.forEach((result, idx) => {
      const recipient = batch[idx];
      // `allSettled` preserves index order, so each result maps to the same recipient index.
      if (result.status === 'fulfilled') {
        results.set(recipient, result.value);
      } else {
        results.set(recipient, {
          success: false,
          error: result.reason?.message ?? 'Unknown error',
        });
      }
    });
  }

  return results;
}

/**
 * Verify SMTP connection. Useful for health checks.
 *
 * @returns `true` when the configured transport verifies successfully, otherwise `false`.
 * @throws This function does not throw; verification failures return `false`.
 * @example
 * ```ts
 * const ready = await verifyEmailTransport();
 * if (!ready) {
 *   console.warn('SMTP transport is not available');
 * }
 * ```
 */
export async function verifyEmailTransport(): Promise<boolean> {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resets the cached transporter singleton.
 *
 * Intended for tests that need to rebuild transport state between cases.
 *
 * @returns Nothing.
 * @throws This function does not throw.
 * @example
 * ```ts
 * _resetTransporter();
 * ```
 */
export function _resetTransporter(): void {
  _transporter = null;
}
