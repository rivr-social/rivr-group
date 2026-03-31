/**
 * Tests for password-reset server actions.
 *
 * Uses real database via withTestTransaction — every test runs inside a
 * transaction that rolls back, giving perfect isolation.
 * Email sending is mocked via setupEmailMock().
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestVerificationToken,
  TEST_PASSWORD,
} from "@/test/fixtures";
import { eq, and, isNull } from "drizzle-orm";
import { agents, emailVerificationTokens, emailLog } from "@/db/schema";
import { verify } from "@node-rs/bcrypt";

// ---------------------------------------------------------------------------
// Mocks — framework & external services only
// ---------------------------------------------------------------------------

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/email", async () => {
  const { setupEmailMock } = await import("@/test/external-mocks");
  return setupEmailMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({
    success: true,
    remaining: 2,
    resetMs: 900_000,
  }),
  RATE_LIMITS: {
    PASSWORD_RESET: { limit: 50, windowMs: 60_000 },
  },
}));

import { rateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import {
  requestPasswordResetAction,
  resetPasswordAction,
} from "../password-reset";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_PASSWORD = "NewSecurePassword456";
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72; // bcrypt truncates at 72 bytes

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("password-reset actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({
      success: true,
      remaining: 2,
      resetMs: 900_000,
    });
    vi.mocked(sendEmail).mockResolvedValue({
      success: true,
      messageId: "test-message-id-123",
      error: undefined,
    });
  });

  // =========================================================================
  // requestPasswordResetAction
  // =========================================================================

  describe("requestPasswordResetAction", () => {
    it("returns success even when email does not exist (anti-enumeration)", () =>
      withTestTransaction(async () => {
        const result = await requestPasswordResetAction("nonexistent@example.com");

        expect(result.success).toBe(true);
        // Should NOT send any email
        expect(sendEmail).not.toHaveBeenCalled();
      }));

    it("returns success for empty email input", () =>
      withTestTransaction(async () => {
        const result = await requestPasswordResetAction("");

        expect(result.success).toBe(true);
        expect(sendEmail).not.toHaveBeenCalled();
      }));

    it("returns rate limit error when rate limit is exceeded", () =>
      withTestTransaction(async () => {
        vi.mocked(rateLimit).mockResolvedValueOnce({
          success: false,
          remaining: 0,
          resetMs: 60_000,
        });

        const result = await requestPasswordResetAction("test@example.com");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many requests");
      }));

    it("creates token and sends email when agent exists", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db, {
          email: "alice@test.com",
          name: "Alice",
        });

        const result = await requestPasswordResetAction("alice@test.com");

        expect(result.success).toBe(true);

        // Verify token was created in DB
        const tokens = await db
          .select()
          .from(emailVerificationTokens)
          .where(
            and(
              eq(emailVerificationTokens.agentId, agent.id),
              eq(emailVerificationTokens.tokenType, "password_reset"),
              isNull(emailVerificationTokens.usedAt)
            )
          );

        expect(tokens.length).toBe(1);
        expect(tokens[0].token).toBeDefined();
        expect(tokens[0].expiresAt).toBeDefined();
        expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

        // Verify email was sent
        expect(sendEmail).toHaveBeenCalledOnce();
        expect(sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "alice@test.com",
            subject: expect.stringContaining("password"),
          })
        );
      }));

    it("invalidates existing tokens before creating a new one", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db, {
          email: "bob@test.com",
          name: "Bob",
        });

        // Create an existing unused password_reset token
        await createTestVerificationToken(db, agent.id, {
          tokenType: "password_reset",
        });

        const result = await requestPasswordResetAction("bob@test.com");

        expect(result.success).toBe(true);

        // Verify the old token was marked as used
        const allTokens = await db
          .select()
          .from(emailVerificationTokens)
          .where(
            and(
              eq(emailVerificationTokens.agentId, agent.id),
              eq(emailVerificationTokens.tokenType, "password_reset")
            )
          );

        const unusedTokens = allTokens.filter((t) => t.usedAt === null);
        // Only the newly created token should be unused
        expect(unusedTokens.length).toBe(1);
      }));

    it("logs the email after sending", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db, {
          email: "log-test@test.com",
          name: "Logger",
        });

        await requestPasswordResetAction("log-test@test.com");

        // Verify email log was created
        const logs = await db
          .select()
          .from(emailLog)
          .where(eq(emailLog.recipientAgentId, agent.id));

        expect(logs.length).toBe(1);
        expect(logs[0].emailType).toBe("password_reset");
        expect(logs[0].status).toBe("sent");
        expect(logs[0].recipientEmail).toBe("log-test@test.com");
      }));

    it("normalizes email to lowercase", () =>
      withTestTransaction(async (db) => {
        await createTestAgent(db, {
          email: "uppercase@test.com",
          name: "Upper",
        });

        const result = await requestPasswordResetAction("UPPERCASE@test.com");

        expect(result.success).toBe(true);
        expect(sendEmail).toHaveBeenCalledOnce();
      }));
  });

  // =========================================================================
  // resetPasswordAction
  // =========================================================================

  describe("resetPasswordAction", () => {
    it("rejects empty token", () =>
      withTestTransaction(async () => {
        const result = await resetPasswordAction("", NEW_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid reset token");
      }));

    it("rejects short passwords", () =>
      withTestTransaction(async () => {
        const result = await resetPasswordAction("validtoken", "short");

        expect(result.success).toBe(false);
        expect(result.error).toContain(`at least ${MINIMUM_PASSWORD_LENGTH} characters`);
      }));

    it("rejects passwords that are too long", () =>
      withTestTransaction(async () => {
        const longPassword = "a".repeat(MAXIMUM_PASSWORD_LENGTH + 1);
        const result = await resetPasswordAction("validtoken", longPassword);

        expect(result.success).toBe(false);
        expect(result.error).toContain(`${MAXIMUM_PASSWORD_LENGTH} characters or fewer`);
      }));

    it("rejects invalid or already-used tokens", () =>
      withTestTransaction(async () => {
        const result = await resetPasswordAction("nonexistent-token", NEW_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid or already-used");
      }));

    it("rejects expired tokens", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);
        const expiredDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
        const token = await createTestVerificationToken(db, agent.id, {
          tokenType: "password_reset",
          expiresAt: expiredDate,
        });

        const result = await resetPasswordAction(token.token, NEW_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toContain("expired");
      }));

    it("succeeds with valid token and updates password hash", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);
        const validExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
        const token = await createTestVerificationToken(db, agent.id, {
          tokenType: "password_reset",
          expiresAt: validExpiry,
        });

        const result = await resetPasswordAction(token.token, NEW_PASSWORD);

        expect(result.success).toBe(true);

        // Verify token was marked as used
        const [updatedToken] = await db
          .select()
          .from(emailVerificationTokens)
          .where(eq(emailVerificationTokens.id, token.id));

        expect(updatedToken.usedAt).not.toBeNull();

        // Verify password was updated
        const [updatedAgent] = await db
          .select({ passwordHash: agents.passwordHash })
          .from(agents)
          .where(eq(agents.id, agent.id));

        expect(updatedAgent.passwordHash).toBeDefined();
        expect(updatedAgent.passwordHash).not.toBe(agent.passwordHash);

        // Verify the new password hash is valid
        const isValid = await verify(NEW_PASSWORD, updatedAgent.passwordHash!);
        expect(isValid).toBe(true);
      }));

    it("prevents reuse of the same token", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);
        const validExpiry = new Date(Date.now() + 60 * 60 * 1000);
        const token = await createTestVerificationToken(db, agent.id, {
          tokenType: "password_reset",
          expiresAt: validExpiry,
        });

        // First reset succeeds
        const firstResult = await resetPasswordAction(token.token, NEW_PASSWORD);
        expect(firstResult.success).toBe(true);

        // Second reset with same token fails
        const secondResult = await resetPasswordAction(token.token, "AnotherPassword123");
        expect(secondResult.success).toBe(false);
        expect(secondResult.error).toContain("Invalid or already-used");
      }));
  });
});
