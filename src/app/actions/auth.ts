"use server";

/**
 * Server actions for authentication and account lifecycle workflows.
 *
 * Purpose:
 * - Authenticate users (`loginAction`, `logoutAction`)
 * - Register accounts with secure password hashing (`signupAction`)
 * - Manage verification email resend flow (`resendVerificationAction`)
 * - Support public resend requests for unverified accounts (`requestVerificationEmailAction`)
 *
 * Key exports:
 * - `loginAction(email, password)`
 * - `signupAction({ name, email, password })`
 * - `logoutAction()`
 * - `resendVerificationAction()`
 *
 * Primary dependencies:
 * - `@/auth` for sign-in/sign-out and session resolution
 * - `@/db` + `@/db/schema` for identity, token, ledger, and email log persistence
 * - `@/lib/rate-limit` for endpoint abuse protection
 * - `@/lib/email` + `@/lib/email-templates` for transactional notifications
 */

import { signIn, signOut } from "@/auth";
import { db } from "@/db";
import { agents, emailVerificationTokens, emailLog, ledger, type NewAgent, type NewLedgerEntry } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { randomBytes } from "crypto";
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { rateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { verificationEmail, loginNotificationEmail } from "@/lib/email-templates";
import { embedAgent, scheduleEmbedding } from "@/lib/ai";
import { provisionMatrixUser } from "@/lib/matrix-admin";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { getClientIp } from "@/lib/client-ip";
import { hashToken } from "@/lib/token-hash";

const BCRYPT_SALT_ROUNDS = 12;
// NIST SP 800-63B recommends a minimum password length of 8 characters
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;

// Email verification token settings
const TOKEN_BYTES = 32;
const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERIFICATION_TOKEN_TYPE = "email_verification";

// Rate limit constants — relaxed in development for E2E testing
const isDev = process.env.NODE_ENV !== "production";
const LOGIN_RATE_LIMIT = isDev ? 100 : 5;
const LOGIN_WINDOW_MS = isDev ? 60 * 1000 : 15 * 60 * 1000; // 1min dev, 15min prod
const SIGNUP_RATE_LIMIT = isDev ? 50 : 3;
const SIGNUP_WINDOW_MS = isDev ? 60 * 1000 : 60 * 60 * 1000; // 1min dev, 1hr prod
const RESEND_VERIFICATION_RATE_LIMIT = 3;
const RESEND_VERIFICATION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

type AuthResult = {
  success: boolean;
  error?: string;
};

/**
 * Creates a rate-limit key component from request headers and optional email.
 *
 * Combining IP, user-agent, and normalized email improves fairness and makes
 * simplistic bot rotation harder compared to IP-only keys.
 */
function getClientIdentifier(headerList: Headers, email?: string): string {
  const ip = getClientIp(headerList);
  const normalizedEmail = (email ?? "").trim().toLowerCase();
  const userAgent = headerList.get("user-agent") ?? "unknown-agent";
  return `${ip}:${userAgent}:${normalizedEmail}`;
}

/**
 * Authenticates a user with credentials and starts a session.
 *
 * @param {string} email - User-provided email address.
 * @param {string} password - Plaintext password entered by the user.
 * @returns {Promise<AuthResult>} Success flag with optional user-safe error message.
 * @throws {AuthError} Mapped internally to safe error messages; not rethrown.
 * @example
 * ```ts
 * const result = await loginAction("user@example.com", "correct-horse-battery-staple");
 * ```
 */
export async function loginAction(
  email: string,
  password: string
): Promise<AuthResult> {
  const normalizedEmail = email.toLowerCase().trim();
  const headersList = await headers();
  const clientIdentifier = getClientIdentifier(headersList, normalizedEmail);

  // Enforce login throttling before auth provider calls to reduce brute-force attempts.
  const limiter = await rateLimit(`login:${clientIdentifier}`, LOGIN_RATE_LIMIT, LOGIN_WINDOW_MS);
  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many login attempts. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  try {
    // Block login for users who haven't verified their email.
    const [user] = await db
      .select({ emailVerified: agents.emailVerified })
      .from(agents)
      .where(eq(agents.email, normalizedEmail))
      .limit(1);

    if (user && !user.emailVerified) {
      return { success: false, error: "Please verify your email before logging in. Check your inbox for a verification link." };
    }

    await signIn("credentials", {
      email: normalizedEmail,
      password,
      redirect: false,
    });

    // Notification delivery is non-blocking so email outages cannot block authentication.
    // Placed after signIn so notifications only fire for successful logins.
    const ipAddress = getClientIp(headersList);
    const userAgent = headersList.get("user-agent") ?? "unknown";
    sendLoginNotification(normalizedEmail, ipAddress, userAgent);

    return { success: true };
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === "CredentialsSignin") {
        return { success: false, error: "Invalid email or password." };
      }
      return { success: false, error: "An unexpected error occurred." };
    }
    // In NextAuth v5 beta, signIn may throw a NEXT_REDIRECT on success even
    // with redirect: false. Re-throw so Next.js handles it properly — the
    // session cookie is already set at this point.
    throw error;
  }
}

/**
 * Registers a new account, creates baseline membership state, and issues verification.
 *
 * Security and business rules:
 * - Applies rate limiting before validation/DB work.
 * - Enforces password length and hashes via bcrypt before persistence.
 * - Uses generic duplicate-email messaging to reduce account enumeration.
 * - Creates a verification token and dispatches email asynchronously.
 *
 * @param {{ name: string; email: string; password: string }} data - Signup payload.
 * @returns {Promise<AuthResult>} Success flag with optional user-safe error message.
 * @throws {AuthError} Handled and converted to safe responses.
 * @example
 * ```ts
 * const result = await signupAction({
 *   name: "Rivr User",
 *   email: "new.user@example.com",
 *   password: "a-strong-password",
 * });
 * ```
 */
export async function signupAction(data: {
  name: string;
  email: string;
  password: string;
  emailNotifications?: boolean;
  acceptedTerms?: boolean;
  murmurationsPublishing?: boolean;
}): Promise<AuthResult> {
  const {
    name,
    email,
    password,
    emailNotifications = true,
    acceptedTerms = false,
    murmurationsPublishing = false,
  } = data;

  const headersList = await headers();
  const clientIdentifier = getClientIdentifier(headersList, email);

  // Restrict signup velocity to limit bot-driven account creation and token spam.
  const limiter = await rateLimit(`signup:${clientIdentifier}`, SIGNUP_RATE_LIMIT, SIGNUP_WINDOW_MS);
  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many signup attempts. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  if (!name || name.trim().length === 0) {
    return { success: false, error: "Name is required." };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { success: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  if (!email || email.trim().length === 0) {
    return { success: false, error: "Email is required." };
  }

  if (email.length > MAX_EMAIL_LENGTH) {
    return { success: false, error: "Email is too long." };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }

  if (!password || password.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be ${MAXIMUM_PASSWORD_LENGTH} characters or fewer.`,
    };
  }

  if (!acceptedTerms) {
    return {
      success: false,
      error: "You must accept the Terms and Conditions to create an account.",
    };
  }

  try {
    const [existingAgent] = await db
      .select({ id: agents.id, metadata: agents.metadata, emailVerified: agents.emailVerified })
      .from(agents)
      .where(eq(agents.email, email.toLowerCase()))
      .limit(1);

    if (existingAgent) {
      const existingMeta = existingAgent.metadata as Record<string, unknown> | null;

      // Guest merge: upgrade a guest agent (noSignin) to a real account.
      if (existingMeta?.noSignin === true) {
        const passwordHash = await hash(password, BCRYPT_SALT_ROUNDS);

        // Remove noSignin flag and preserve other metadata.
        const { noSignin: _, ...remainingMeta } = existingMeta;

        await db
          .update(agents)
          .set({
            name: name.trim(),
            passwordHash,
            metadata: {
              ...remainingMeta,
              emailNotifications,
              notificationSettings: {
                ...(remainingMeta.notificationSettings as Record<string, unknown> | undefined),
                emailNotifications,
              },
              termsAcceptedAt: new Date().toISOString(),
              murmurationsPublishing,
            },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, existingAgent.id));

        // Ensure platform org membership for the upgraded guest.
        await ensureRivrMembership(existingAgent.id);

        // Fire-and-forget: embed the user for semantic discovery.
        scheduleEmbedding(() => embedAgent(existingAgent.id, name.trim()));

        // Provision Matrix user (non-blocking).
        provisionMatrixUserForAgent(existingAgent.id, name.trim(), email.toLowerCase().trim());
        if (murmurationsPublishing) {
          void syncMurmurationsProfilesForActor(existingAgent.id).catch((err) => {
            console.error("[murmurations] Failed to sync upgraded guest profiles:", err);
          });
        }

        void sendVerificationEmail({
          agentId: existingAgent.id,
          name: name.trim(),
          email: email.toLowerCase().trim(),
        }).catch((err) => console.error("[email] Failed to send verification email:", err));

        return { success: true };
      }

      if (!existingAgent.emailVerified) {
        return { success: true };
      }

      // Keep duplicate-account handling non-enumerating by returning the same
      // public flow used for new and existing-unverified accounts.
      return { success: true };
    }

    const passwordHash = await hash(password, BCRYPT_SALT_ROUNDS);

    const [newAgent] = await db
      .insert(agents)
      .values({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        type: "person",
        metadata: {
          emailNotifications,
          notificationSettings: {
            emailNotifications,
          },
          termsAcceptedAt: new Date().toISOString(),
          murmurationsPublishing,
        },
      } as NewAgent)
      .returning({ id: agents.id });

    // Ensure every user is a member of the platform org (RIVR).
    await ensureRivrMembership(newAgent.id);

    // Fire-and-forget: embed the new user's name for semantic discovery.
    scheduleEmbedding(() => embedAgent(newAgent.id, name.trim()));

    // Provision Matrix user account (non-blocking — signup succeeds even if Matrix is unavailable).
    provisionMatrixUserForAgent(newAgent.id, name.trim(), email.toLowerCase().trim());
    if (murmurationsPublishing) {
      void syncMurmurationsProfilesForActor(newAgent.id).catch((err) => {
        console.error("[murmurations] Failed to sync signup profiles:", err);
      });
    }

    void sendVerificationEmail({
      agentId: newAgent.id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
    }).catch((err) => console.error("[email] Failed to send verification email:", err));

    // Do NOT auto-login — require email verification first.
    return { success: true };
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, error: "Authentication failed. Please try again." };
    }
    throw error;
  }
}

/**
 * Ensures a user has an active "belong" ledger edge to the RIVR org when present.
 *
 * This enrichment is best-effort. Errors are logged and intentionally not surfaced
 * to avoid blocking account creation.
 */
async function ensureRivrMembership(agentId: string): Promise<void> {
  try {
    const [rivrOrg] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.type, "organization"),
          eq(agents.name, "RIVR"),
          isNull(agents.deletedAt)
        )
      )
      .limit(1);

    if (!rivrOrg) return;

    const [existingMembership] = await db
      .select({ id: ledger.id })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, agentId),
          eq(ledger.objectId, rivrOrg.id),
          eq(ledger.verb, "belong"),
          eq(ledger.isActive, true)
        )
      )
      .limit(1);

    if (existingMembership) return;

    await db.insert(ledger).values({
      verb: "belong",
      subjectId: agentId,
      objectId: rivrOrg.id,
      objectType: "agent",
      isActive: true,
      role: "member",
      metadata: {
        action: "auto_join_platform_org",
        source: "signup",
      },
    } as NewLedgerEntry);
  } catch (error) {
    console.error("[auth] failed to auto-join RIVR organization:", error);
  }
}

/**
 * Ends the current authenticated session.
 *
 * @param {void} _ - This action does not accept input parameters.
 * @returns {Promise<void>} Resolves when sign-out completes.
 * @throws {Error} Any provider-level sign-out exception.
 * @example
 * ```ts
 * await logoutAction();
 * ```
 */
export async function logoutAction(): Promise<void> {
  await signOut({ redirect: false });
}

/**
 * Resends the verification email for the authenticated account.
 *
 * @param {void} _ - This action does not accept input parameters.
 * @returns {Promise<AuthResult>} Success flag with optional user-safe error message.
 * @throws {Error} Email/DB errors are handled and converted to action results.
 * @example
 * ```ts
 * const result = await resendVerificationAction();
 * ```
 */
export async function resendVerificationAction(): Promise<AuthResult> {
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  const headersList = await headers();
  const clientIp = getClientIp(headersList);

  // Rate-limit by IP + user ID to control resend abuse while allowing normal retries.
  const limiter = await rateLimit(
    `resend_verification:${clientIp}:${session.user.id}`,
    RESEND_VERIFICATION_RATE_LIMIT,
    RESEND_VERIFICATION_WINDOW_MS
  );

  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many requests. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  // Fetch agent
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, email: agents.email, emailVerified: agents.emailVerified })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  if (!agent || !agent.email) {
    return { success: false, error: "Account not found." };
  }

  if (agent.emailVerified) {
    return { success: false, error: "Email is already verified." };
  }

  const result = await sendVerificationEmail({
    agentId: agent.id,
    name: agent.name,
    email: agent.email,
    invalidateExisting: true,
  });

  if (!result.success) {
    return { success: false, error: "Failed to send verification email. Please try again." };
  }

  return { success: true };
}

/**
 * Requests a fresh verification email for an email address without requiring a session.
 *
 * The response is intentionally generic so unauthenticated callers cannot use this
 * endpoint to enumerate which email addresses already exist on the platform.
 */
export async function requestVerificationEmailAction(email: string): Promise<AuthResult> {
  const normalizedEmail = email.toLowerCase().trim();

  if (!normalizedEmail) {
    return { success: false, error: "Email is required." };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, error: "Please enter a valid email address." };
  }

  const headersList = await headers();
  const clientIdentifier = getClientIdentifier(headersList, normalizedEmail);
  const limiter = await rateLimit(
    `request_verification:${clientIdentifier}`,
    RESEND_VERIFICATION_RATE_LIMIT,
    RESEND_VERIFICATION_WINDOW_MS
  );

  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many requests. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  const [agent] = await db
    .select({ id: agents.id, name: agents.name, email: agents.email, emailVerified: agents.emailVerified })
    .from(agents)
    .where(eq(agents.email, normalizedEmail))
    .limit(1);

  if (!agent || !agent.email || agent.emailVerified) {
    return { success: true };
  }

  const result = await sendVerificationEmail({
    agentId: agent.id,
    name: agent.name,
    email: agent.email,
    invalidateExisting: true,
  });

  if (!result.success) {
    console.error("[email] Public verification resend failed:", result.error);
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function sendVerificationEmail(params: {
  agentId: string;
  name: string;
  email: string;
  invalidateExisting?: boolean;
}) {
  const { agentId, name, email, invalidateExisting = false } = params;

  if (invalidateExisting) {
    await db
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(emailVerificationTokens.agentId, agentId));
  }

  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS);

  // Store hashed token — raw token only travels via email link
  await db.insert(emailVerificationTokens).values({
    agentId,
    token: hashToken(rawToken),
    tokenType: VERIFICATION_TOKEN_TYPE,
    expiresAt,
  });

  const template = verificationEmail(name, rawToken);
  const result = await sendEmail({
    to: email,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  await db.insert(emailLog).values({
    recipientEmail: email,
    recipientAgentId: agentId,
    subject: template.subject,
    emailType: "verification",
    status: result.success ? "sent" : "failed",
    messageId: result.messageId,
    error: result.error,
  });

  return result;
}

/**
 * Provisions a Matrix user and stores credentials in the agents table.
 *
 * Runs asynchronously so signup completion is not blocked by Matrix availability.
 * The localpart is derived from the agent UUID to ensure uniqueness across the
 * homeserver without collision risk from user-chosen names.
 */
function provisionMatrixUserForAgent(
  agentId: string,
  displayName: string,
  _email: string
): void {
  (async () => {
    try {
      // Use agent ID as localpart for guaranteed uniqueness
      const localpart = agentId.replace(/-/g, "");
      const result = await provisionMatrixUser({
        localpart,
        displayName,
      });

      // Store Matrix credentials on the agent record
      await db
        .update(agents)
        .set({
          matrixUserId: result.matrixUserId,
          matrixAccessToken: result.accessToken,
        })
        .where(eq(agents.id, agentId));

      console.log(`[matrix] Provisioned Matrix user for agent ${agentId}: ${result.matrixUserId}`);
    } catch (err) {
      // Matrix provisioning failure must not block signup.
      // Users without Matrix credentials will be prompted to retry later.
      console.error("[matrix] Failed to provision Matrix user:", err);
    }
  })();
}

/**
 * Sends a login notification email asynchronously.
 *
 * Any failure is caught and logged to preserve login availability.
 */
function sendLoginNotification(
  email: string,
  ipAddress: string,
  userAgent: string
): void {
  (async () => {
    try {
      const [agent] = await db
        .select({ id: agents.id, name: agents.name, email: agents.email })
        .from(agents)
        .where(eq(agents.email, email))
        .limit(1);

      if (!agent || !agent.email) return;

      const template = loginNotificationEmail(agent.name, ipAddress, userAgent);
      const result = await sendEmail({
        to: agent.email,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      await db.insert(emailLog).values({
        recipientEmail: agent.email,
        recipientAgentId: agent.id,
        subject: template.subject,
        emailType: "login_notification",
        status: result.success ? "sent" : "failed",
        messageId: result.messageId,
        error: result.error,
      });
    } catch (err) {
      console.error("[email] Login notification error:", err);
    }
  })();
}
