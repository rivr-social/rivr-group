import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, TEST_PASSWORD, TEST_PASSWORD_HASH } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents, emailVerificationTokens, ledger } from "@/db/schema";

// =============================================================================
// Mocks
// =============================================================================

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

vi.mock("@/lib/email-templates", () => ({
  verificationEmail: vi.fn(() => ({
    subject: "Verify your email",
    html: "<p>verify</p>",
    text: "verify",
  })),
  loginNotificationEmail: vi.fn(() => ({
    subject: "New login",
    html: "<p>login</p>",
    text: "login",
  })),
}));

vi.mock("next-auth", () => {
  class AuthError extends Error {
    type: string;
    constructor(message?: string) {
      super(message);
      this.type = "CredentialsSignin";
    }
  }
  return { AuthError };
});

// Import AFTER all mocks
import { signIn, signOut } from "@/auth";
import { loginAction, signupAction, logoutAction } from "../auth";

// =============================================================================
// Constants
// =============================================================================

const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72; // bcrypt truncates at 72 bytes
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;

const VALID_EMAIL = "signup-test@example.com";
const VALID_PASSWORD = "securePassword123";
const VALID_NAME = "Test User";

// =============================================================================
// Tests
// =============================================================================

describe("auth actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: signIn succeeds
    vi.mocked(signIn).mockResolvedValue(undefined as never);
    vi.mocked(signOut).mockResolvedValue(undefined as never);
  });

  // ===========================================================================
  // loginAction
  // ===========================================================================

  describe("loginAction", () => {
    it("calls signIn with correct arguments and returns success", () =>
      withTestTransaction(async () => {
        const result = await loginAction(VALID_EMAIL, VALID_PASSWORD);

        expect(result).toEqual({ success: true });
        expect(vi.mocked(signIn)).toHaveBeenCalledWith("credentials", {
          email: VALID_EMAIL,
          password: VALID_PASSWORD,
          redirect: false,
        });
      }));

    it("normalizes email to lowercase before calling signIn", () =>
      withTestTransaction(async () => {
        await loginAction("User@Example.COM", VALID_PASSWORD);

        expect(vi.mocked(signIn)).toHaveBeenCalledWith("credentials", {
          email: "user@example.com",
          password: VALID_PASSWORD,
          redirect: false,
        });
      }));

    it("returns error on CredentialsSignin AuthError", () =>
      withTestTransaction(async () => {
        const { AuthError } = await import("next-auth");
        const authErr = new AuthError("CredentialsSignin");
        (authErr as { type: string }).type = "CredentialsSignin";
        vi.mocked(signIn).mockRejectedValueOnce(authErr);

        const result = await loginAction(VALID_EMAIL, VALID_PASSWORD);

        expect(result).toEqual({
          success: false,
          error: "Invalid email or password.",
        });
      }));

    it("returns generic error on non-AuthError", () =>
      withTestTransaction(async () => {
        vi.mocked(signIn).mockRejectedValueOnce(new Error("Network failure"));

        const result = await loginAction(VALID_EMAIL, VALID_PASSWORD);

        expect(result).toEqual({
          success: false,
          error: "An unexpected error occurred.",
        });
      }));
  });

  // ===========================================================================
  // signupAction
  // ===========================================================================

  describe("signupAction", () => {
    const validData = {
      name: VALID_NAME,
      email: VALID_EMAIL,
      password: VALID_PASSWORD,
      acceptedTerms: true,
    };

    // -------------------------------------------------------------------------
    // Validation: name
    // -------------------------------------------------------------------------

    it("returns error when name is empty string", () =>
      withTestTransaction(async () => {
        const result = await signupAction({ ...validData, name: "" });

        expect(result).toEqual({
          success: false,
          error: "Name is required.",
        });
      }));

    it("returns error when name is only whitespace", () =>
      withTestTransaction(async () => {
        const result = await signupAction({ ...validData, name: "   " });

        expect(result).toEqual({
          success: false,
          error: "Name is required.",
        });
      }));

    it("returns error when name exceeds max length", () =>
      withTestTransaction(async () => {
        const longName = "A".repeat(MAX_NAME_LENGTH + 1);
        const result = await signupAction({ ...validData, name: longName });

        expect(result).toEqual({
          success: false,
          error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        });
      }));

    // -------------------------------------------------------------------------
    // Validation: email
    // -------------------------------------------------------------------------

    it("returns error when email is empty string", () =>
      withTestTransaction(async () => {
        const result = await signupAction({ ...validData, email: "" });

        expect(result).toEqual({
          success: false,
          error: "Email is required.",
        });
      }));

    it("returns error when email is only whitespace", () =>
      withTestTransaction(async () => {
        const result = await signupAction({ ...validData, email: "   " });

        expect(result).toEqual({
          success: false,
          error: "Email is required.",
        });
      }));

    it("returns error when email exceeds max length", () =>
      withTestTransaction(async () => {
        const longEmail = "a".repeat(MAX_EMAIL_LENGTH) + "@example.com";
        const result = await signupAction({
          ...validData,
          email: longEmail,
        });

        expect(result).toEqual({
          success: false,
          error: "Email is too long.",
        });
      }));

    it("returns error for invalid email format", () =>
      withTestTransaction(async () => {
        const result = await signupAction({
          ...validData,
          email: "not-an-email",
        });

        expect(result).toEqual({
          success: false,
          error: "Please enter a valid email address.",
        });
      }));

    // -------------------------------------------------------------------------
    // Validation: password
    // -------------------------------------------------------------------------

    it("returns error when password is too short", () =>
      withTestTransaction(async () => {
        const result = await signupAction({
          ...validData,
          password: "short",
        });

        expect(result).toEqual({
          success: false,
          error: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
        });
      }));

    it("returns error when password is empty", () =>
      withTestTransaction(async () => {
        const result = await signupAction({ ...validData, password: "" });

        expect(result).toEqual({
          success: false,
          error: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
        });
      }));

    it("returns error when password exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await signupAction({
          ...validData,
          password: "x".repeat(MAXIMUM_PASSWORD_LENGTH + 1),
        });

        expect(result).toEqual({
          success: false,
          error: `Password must be ${MAXIMUM_PASSWORD_LENGTH} characters or fewer.`,
        });
      }));

    // -------------------------------------------------------------------------
    // Existing user (duplicate email)
    // -------------------------------------------------------------------------

    it("returns the same public success response when a verified email already exists", () =>
      withTestTransaction(async (txDb) => {
        await createTestAgent(txDb, {
          email: "existing@example.com",
          emailVerified: new Date(),
        });

        const result = await signupAction({
          ...validData,
          email: "existing@example.com",
        });

        expect(result).toEqual({ success: true });
      }));

    it("returns the same public success response when an unverified email already exists", () =>
      withTestTransaction(async (txDb) => {
        await createTestAgent(txDb, { email: "pending@example.com" });

        const result = await signupAction({
          ...validData,
          email: "pending@example.com",
        });

        expect(result).toEqual({ success: true });
      }));

    // -------------------------------------------------------------------------
    // Successful signup
    // -------------------------------------------------------------------------

    it("creates agent row in DB with hashed password without auto-login", () =>
      withTestTransaction(async (txDb) => {
        const uniqueEmail = `signup-success-${Date.now()}@example.com`;

        const result = await signupAction({
          name: "New User",
          email: uniqueEmail,
          password: VALID_PASSWORD,
        });

        expect(result).toEqual({ success: true });

        // Verify agent was created in DB
        const [newAgent] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.email, uniqueEmail));

        expect(newAgent).toBeDefined();
        expect(newAgent.name).toBe("New User");
        expect(newAgent.type).toBe("person");
        // Password should be hashed (not stored as plaintext)
        expect(newAgent.passwordHash).toBeDefined();
        expect(newAgent.passwordHash).not.toBe(VALID_PASSWORD);
        expect(newAgent.passwordHash!.startsWith("$")).toBe(true);
        expect(vi.mocked(signIn)).not.toHaveBeenCalled();
      }));

    it("trims name and lowercases email", () =>
      withTestTransaction(async (txDb) => {
        const uniqueEmail = `PADDED-${Date.now()}@Example.COM`;

        const result = await signupAction({
          name: "  Padded Name  ",
          email: uniqueEmail,
          password: VALID_PASSWORD,
        });

        expect(result).toEqual({ success: true });

        const normalizedEmail = uniqueEmail.toLowerCase().trim();
        const [agent] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.email, normalizedEmail));

        expect(agent).toBeDefined();
        expect(agent.name).toBe("Padded Name");
        expect(agent.email).toBe(normalizedEmail);
      }));

    it("creates email verification token after signup", () =>
      withTestTransaction(async (txDb) => {
        const uniqueEmail = `verify-${Date.now()}@example.com`;

        const result = await signupAction({
          name: "Verify User",
          email: uniqueEmail,
          password: VALID_PASSWORD,
        });

        expect(result).toEqual({ success: true });

        // Find the new agent
        const [agent] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.email, uniqueEmail));

        // Verify token was created
        const tokens = await txDb
          .select()
          .from(emailVerificationTokens)
          .where(eq(emailVerificationTokens.agentId, agent.id));

        expect(tokens.length).toBeGreaterThanOrEqual(1);
        const token = tokens[0];
        expect(token.tokenType).toBe("email_verification");
        expect(token.expiresAt).toBeDefined();
        expect(token.token.length).toBeGreaterThan(0);
      }));

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    it("requires terms acceptance before creating an account", () =>
      withTestTransaction(async () => {
        const result = await signupAction({
          ...validData,
          acceptedTerms: false,
        });

        expect(result).toEqual({
          success: false,
          error: "You must accept the Terms and Conditions to create an account.",
        });
      }));
  });

  // ===========================================================================
  // logoutAction
  // ===========================================================================

  describe("logoutAction", () => {
    it("calls signOut with redirect: false", () =>
      withTestTransaction(async () => {
        await logoutAction();

        expect(vi.mocked(signOut)).toHaveBeenCalledWith({ redirect: false });
      }));

    it("returns void (undefined)", () =>
      withTestTransaction(async () => {
        const result = await logoutAction();

        expect(result).toBeUndefined();
      }));
  });
});
