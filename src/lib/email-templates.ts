/**
 * Centralized HTML/text email template builders for common account and group flows.
 *
 * Key exports:
 * - `verificationEmail`: email verification link content.
 * - `passwordResetEmail`: password reset link content.
 * - `loginNotificationEmail`: security login alert content.
 * - `groupBroadcastEmail`: group-wide broadcast content.
 * - `systemNotificationEmail`: generic platform notification content.
 * - `trialEndingReminderEmail`: reminder before Stripe trial auto-conversion.
 *
 * Dependencies:
 * - `getEnv` from `@/lib/env` for resolving the canonical app base URL.
 */
import { getEnv } from '@/lib/env';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Branded application name used in subjects and body copy. */
const APP_NAME = 'Rivr';

/** Resolves the externally reachable app URL used in email links. */
function getBaseUrl(): string {
  return getEnv('NEXTAUTH_URL');
}

// ---------------------------------------------------------------------------
// Shared layout wrapper
// ---------------------------------------------------------------------------

function wrapInLayout(bodyContent: string): string {
  // Shared wrapper keeps a consistent style across clients and templates.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME}</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; color: #18181b; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #ffffff; border-radius: 8px; padding: 32px; border: 1px solid #e4e4e7; }
    .button { display: inline-block; background: #18181b; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; }
    .footer { margin-top: 32px; text-align: center; color: #71717a; font-size: 13px; }
    h1 { margin: 0 0 16px 0; font-size: 24px; }
    p { margin: 0 0 16px 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      ${bodyContent}
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Email types
// ---------------------------------------------------------------------------

export interface EmailContent {
  /** Subject line to send to the recipient. */
  subject: string;
  /** HTML body rendered by modern email clients. */
  html: string;
  /** Plain-text fallback for accessibility and simple clients. */
  text: string;
}

function formatTrialEndDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Creates an account verification email payload.
 *
 * @param name - Recipient display name for greeting text.
 * @param token - Email verification token included in the verification URL.
 * @returns Subject + HTML + plain-text content for a verification email.
 * @throws This function does not throw directly; environment lookup may throw in strict production config.
 * @example
 * ```ts
 * const content = verificationEmail('Avery', 'token-123');
 * await sendEmail({ to: 'avery@example.com', ...content });
 * ```
 */
export function verificationEmail(name: string, token: string): EmailContent {
  // Token is URL-encoded to prevent malformed links and query-string injection.
  const url = `${getBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;

  return {
    subject: `Verify your ${APP_NAME} email`,
    html: wrapInLayout(`
      <h1>Welcome to ${APP_NAME}, ${name}!</h1>
      <p>Please verify your email address by clicking the button below.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${url}" class="button">Verify Email</a>
      </p>
      <p style="font-size: 13px; color: #71717a;">
        If the button doesn't work, copy and paste this link:<br/>
        <a href="${url}">${url}</a>
      </p>
      <p style="font-size: 13px; color: #71717a;">
        This link expires in 24 hours. If you didn't create an account, ignore this email.
      </p>
    `),
    text: `Welcome to ${APP_NAME}, ${name}!\n\nVerify your email: ${url}\n\nThis link expires in 24 hours.`,
  };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Creates a password reset email payload.
 *
 * @param name - Recipient display name for greeting text.
 * @param token - Password reset token included in the reset URL.
 * @returns Subject + HTML + plain-text content for a password reset email.
 * @throws This function does not throw directly; environment lookup may throw in strict production config.
 * @example
 * ```ts
 * const content = passwordResetEmail('Avery', 'token-123');
 * await sendEmail({ to: 'avery@example.com', ...content });
 * ```
 */
export function passwordResetEmail(name: string, token: string): EmailContent {
  // URL-encode token to preserve integrity across mail client link rewriting.
  const url = `${getBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`;

  return {
    subject: `Reset your ${APP_NAME} password`,
    html: wrapInLayout(`
      <h1>Password Reset</h1>
      <p>Hi ${name}, we received a request to reset your password.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${url}" class="button">Reset Password</a>
      </p>
      <p style="font-size: 13px; color: #71717a;">
        If the button doesn't work, copy and paste this link:<br/>
        <a href="${url}">${url}</a>
      </p>
      <p style="font-size: 13px; color: #71717a;">
        This link expires in 1 hour. If you didn't request this, ignore this email.
      </p>
    `),
    text: `Hi ${name},\n\nReset your password: ${url}\n\nThis link expires in 1 hour.`,
  };
}

// ---------------------------------------------------------------------------
// Login notification
// ---------------------------------------------------------------------------

/**
 * Creates a security notification email for newly detected logins.
 *
 * @param name - Recipient display name.
 * @param ipAddress - Source IP address observed for the login event.
 * @param userAgent - Client/device fingerprint string.
 * @returns Subject + HTML + plain-text content for a login notification.
 * @throws This function does not throw.
 * @example
 * ```ts
 * const content = loginNotificationEmail('Avery', '203.0.113.1', 'Chrome on macOS');
 * await sendEmail({ to: 'avery@example.com', ...content });
 * ```
 */
export function loginNotificationEmail(
  name: string,
  ipAddress: string,
  userAgent: string,
): EmailContent {
  // ISO timestamp avoids locale ambiguity in security-sensitive notifications.
  const timestamp = new Date().toISOString();

  return {
    subject: `New login to your ${APP_NAME} account`,
    html: wrapInLayout(`
      <h1>New Login Detected</h1>
      <p>Hi ${name}, a new login was detected on your account.</p>
      <table style="width:100%; font-size:14px; margin: 16px 0;">
        <tr><td style="color:#71717a; padding:4px 8px;">Time</td><td style="padding:4px 8px;">${timestamp}</td></tr>
        <tr><td style="color:#71717a; padding:4px 8px;">IP Address</td><td style="padding:4px 8px;">${ipAddress}</td></tr>
        <tr><td style="color:#71717a; padding:4px 8px;">Device</td><td style="padding:4px 8px;">${userAgent}</td></tr>
      </table>
      <p style="font-size: 13px; color: #71717a;">
        If this was you, no action is needed. If you don't recognize this activity,
        please change your password immediately.
      </p>
    `),
    text: `Hi ${name},\n\nNew login detected at ${timestamp}\nIP: ${ipAddress}\nDevice: ${userAgent}\n\nIf this wasn't you, change your password immediately.`,
  };
}

// ---------------------------------------------------------------------------
// Group broadcast
// ---------------------------------------------------------------------------

/**
 * Creates an email payload for group broadcast announcements.
 *
 * @param groupName - Name of the group where the broadcast originated.
 * @param senderName - Human-readable sender name displayed in the message.
 * @param subject - Broadcast subject line.
 * @param bodyContent - Preformatted HTML body snippet for the announcement.
 * @returns Subject + HTML + plain-text content for a broadcast email.
 * @throws This function does not throw.
 * @example
 * ```ts
 * const content = groupBroadcastEmail('Core Team', 'Avery', 'Standup', '<p>10:00 AM daily</p>');
 * await sendEmail({ to: 'member@example.com', ...content });
 * ```
 */
export function groupBroadcastEmail(
  groupName: string,
  senderName: string,
  subject: string,
  bodyContent: string,
): EmailContent {
  const escapedBody = bodyContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const htmlBody = escapedBody
    .split(/\r?\n\r?\n/)
    .map((paragraph: string) => `<p style="margin: 0 0 12px;">${paragraph.replace(/\r?\n/g, "<br />")}</p>`)
    .join("");

  return {
    subject: `[${groupName}] ${subject}`,
    html: wrapInLayout(`
      <h1>${subject}</h1>
      <p style="font-size: 13px; color: #71717a;">From ${senderName} in ${groupName}</p>
      <div style="margin: 16px 0; padding: 16px; background: #f4f4f5; border-radius: 6px;">
        ${htmlBody}
      </div>
      <p style="font-size: 13px; color: #71717a;">
        You received this email because you are a member of ${groupName} and have email notifications enabled.
        Manage your notification preferences in your group settings.
      </p>
    `),
    text: `[${groupName}] ${subject}\n\nFrom ${senderName}:\n\n${bodyContent}\n\nYou received this because you are a member of ${groupName}.`,
  };
}

// ---------------------------------------------------------------------------
// System notification (generic)
// ---------------------------------------------------------------------------

/**
 * Creates a generic system notification email payload.
 *
 * @param name - Recipient display name.
 * @param title - Notification title used in subject and heading.
 * @param bodyContent - Notification body content block.
 * @returns Subject + HTML + plain-text content for a system notification.
 * @throws This function does not throw.
 * @example
 * ```ts
 * const content = systemNotificationEmail('Avery', 'Policy Update', '<p>Terms changed.</p>');
 * await sendEmail({ to: 'avery@example.com', ...content });
 * ```
 */
export function systemNotificationEmail(
  name: string,
  title: string,
  bodyContent: string,
): EmailContent {
  // `bodyContent` is inserted as HTML to support rich notices from trusted server-side sources.
  return {
    subject: `${APP_NAME}: ${title}`,
    html: wrapInLayout(`
      <h1>${title}</h1>
      <p>Hi ${name},</p>
      <div style="margin: 16px 0;">
        ${bodyContent}
      </div>
    `),
    text: `${title}\n\nHi ${name},\n\n${bodyContent}`,
  };
}

export function trialEndingReminderEmail(
  name: string,
  tierName: string,
  trialEndsAt: Date,
  manageUrl: string,
): EmailContent {
  const formattedDate = formatTrialEndDate(trialEndsAt);

  return {
    subject: `Your ${APP_NAME} ${tierName} trial ends in 5 days`,
    html: wrapInLayout(`
      <h1>Your ${tierName} trial is almost over</h1>
      <p>Hi ${name}, your ${tierName} membership trial will automatically convert to a paid subscription on <strong>${formattedDate}</strong>.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${manageUrl}" class="button">Manage Billing</a>
      </p>
      <p style="font-size: 13px; color: #71717a;">
        Your payment method is already saved with Stripe. If you want to make changes before renewal, use the billing page before your trial ends.
      </p>
    `),
    text: `Hi ${name},\n\nYour ${tierName} membership trial will automatically convert to a paid subscription on ${formattedDate}.\n\nManage billing: ${manageUrl}`,
  };
}
