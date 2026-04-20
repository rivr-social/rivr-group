"use server";

/**
 * @file Password reset server action module.
 * @description Exports actions to request password reset emails and complete password resets
 * via one-time tokens. Includes anti-enumeration responses, rate limiting, token rotation,
 * and email/audit logging.
 * @dependencies `@/db`, `@/db/schema`, `@/lib/rate-limit`, `@/lib/mailer`,
 * `@/lib/email-templates`, `@node-rs/bcrypt`, `crypto`, `next/headers`, `drizzle-orm`
 */

import { db } from "@/db";
import { agents, emailVerificationTokens, emailLog } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { randomBytes } from "crypto";
import { headers } from "next/headers";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendTransactionalEmail } from "@/lib/mailer";
import { passwordResetEmail } from "@/lib/email-templates";
import { getClientIp } from "@/lib/client-ip";
import { hashToken } from "@/lib/token-hash";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BCRYPT_SALT_ROUNDS = 12;
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72; // bcrypt truncates at 72 bytes
const TOKEN_BYTES = 32;
const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_TYPE = "password_reset";

type ResetResult = {
  success: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Request a password-reset email for an account.
 *
 * Auth requirement: none (public action).
 * Rate limiting: enforced per client IP using `RATE_LIMITS.PASSWORD_RESET`.
 * Security rule: returns success for unknown emails to prevent account enumeration.
 * Error handling pattern: throttling errors are explicit; non-existent email paths are intentionally silent.
 *
 * @param {string} email - User-provided email address.
 * @returns {Promise<ResetResult>} Success result for accepted requests or rate-limit errors.
 * @throws {never} This function returns structured results and does not throw on expected failures.
 *
 * @example
 * const result = await requestPasswordResetAction("user@example.com");
 * if (!result.success) console.error(result.error);
 */
export async function requestPasswordResetAction(
  email: string
): Promise<ResetResult> {
  const headersList = await headers();
  const clientIp = getClientIp(headersList);

  // Public endpoint guardrail against scripted reset-email abuse.
  const limiter = await rateLimit(
    `password_reset:${clientIp}`,
    RATE_LIMITS.PASSWORD_RESET.limit,
    RATE_LIMITS.PASSWORD_RESET.windowMs
  );

  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many requests. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  if (!email || email.trim().length === 0) {
    // Maintain indistinguishable responses for invalid/blank input.
    return { success: true };
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Do not expose account existence via response differences.
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, email: agents.email })
    .from(agents)
    .where(eq(agents.email, normalizedEmail))
    .limit(1);

  if (!agent || !agent.email) {
    // Silent success preserves anti-enumeration guarantees.
    return { success: true };
  }

  // Invalidate previous unused reset tokens so only the latest token can be used.
  const now = new Date();
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.agentId, agent.id),
        eq(emailVerificationTokens.tokenType, TOKEN_TYPE),
        isNull(emailVerificationTokens.usedAt)
      )
    );

  // Generate cryptographically secure token with bounded TTL.
  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

  // Store hashed token — raw token only travels via email link
  await db.insert(emailVerificationTokens).values({
    agentId: agent.id,
    token: hashToken(rawToken),
    tokenType: TOKEN_TYPE,
    expiresAt,
  });

  // Send reset link payload via email provider/template layer.
  const template = passwordResetEmail(agent.name, rawToken);
  const result = await sendTransactionalEmail({
    kind: "password-reset",
    to: agent.email,
    subject: template.subject,
    html: template.html,
    text: template.text,
    recipientAgentId: agent.id,
    meta: { flow: "password_reset" },
  });

  // Record send attempt outcome for operational visibility and audits.
  await db.insert(emailLog).values({
    recipientEmail: agent.email,
    recipientAgentId: agent.id,
    subject: template.subject,
    emailType: TOKEN_TYPE,
    status: result.success ? "sent" : "failed",
    messageId: result.messageId,
    error: result.error,
  });

  return { success: true };
}

/**
 * Reset account password using a valid one-time reset token.
 *
 * Auth requirement: none (token authorizes operation).
 * Rate limiting: none in this action; relies on token entropy/expiry and request action throttling.
 * Error handling pattern: token/password validation failures return structured errors.
 *
 * @param {string} token - Password reset token from email.
 * @param {string} newPassword - New plaintext password to hash and store.
 * @returns {Promise<ResetResult>} Success status or user-facing validation error.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await resetPasswordAction(tokenFromUrl, "new-secure-password-123");
 * if (result.success) console.log("Password reset complete");
 */
export async function resetPasswordAction(
  token: string,
  newPassword: string
): Promise<ResetResult> {
  if (!token || token.trim().length === 0) {
    return { success: false, error: "Invalid reset token." };
  }

  if (!newPassword || newPassword.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    };
  }

  if (newPassword.length > MAXIMUM_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be ${MAXIMUM_PASSWORD_LENGTH} characters or fewer.`,
    };
  }

  // Hash the incoming token to match against stored hashed tokens
  const hashedToken = hashToken(token);
  const [record] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.token, hashedToken),
        eq(emailVerificationTokens.tokenType, TOKEN_TYPE),
        isNull(emailVerificationTokens.usedAt)
      )
    )
    .limit(1);

  if (!record) {
    return { success: false, error: "Invalid or already-used reset token." };
  }

  if (record.expiresAt < new Date()) {
    return {
      success: false,
      error: "Reset link has expired. Please request a new one.",
    };
  }

  // Consume token before password update to enforce one-time semantics.
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokens.id, record.id));

  // Persist only hashed password material; plaintext is never stored.
  const passwordHash = await hash(newPassword, BCRYPT_SALT_ROUNDS);
  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, record.agentId))
    .limit(1);
  const metadata =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  await db
    .update(agents)
    .set({
      passwordHash,
      metadata: {
        ...metadata,
        passwordChangedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, record.agentId));

  return { success: true };
}
