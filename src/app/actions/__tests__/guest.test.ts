import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
import { agents } from "@/db/schema";

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

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
}));

vi.mock("@/lib/client-ip", () => ({
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// Import AFTER all mocks
import { rateLimit } from "@/lib/rate-limit";
import { createGuestAgentAction, findGuestByEmailAction } from "../guest";

// =============================================================================
// Constants
// =============================================================================

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;

const VALID_NAME = "Guest User";
const VALID_EMAIL = "guest@example.com";

// =============================================================================
// Tests
// =============================================================================

describe("guest actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
  });

  // ===========================================================================
  // createGuestAgentAction
  // ===========================================================================

  describe("createGuestAgentAction", () => {
    it("returns rate limit error when limit is exceeded", () =>
      withTestTransaction(async () => {
        vi.mocked(rateLimit).mockResolvedValue({ success: false, resetMs: 60000 });

        const result = await createGuestAgentAction(VALID_NAME, VALID_EMAIL);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many requests");
        expect(result.error).toContain("60 seconds");
      }));

    it("returns error when name is empty", () =>
      withTestTransaction(async () => {
        const result = await createGuestAgentAction("", VALID_EMAIL);
        expect(result).toEqual({ success: false, error: "Name is required." });
      }));

    it("returns error when name is only whitespace", () =>
      withTestTransaction(async () => {
        const result = await createGuestAgentAction("   ", VALID_EMAIL);
        expect(result).toEqual({ success: false, error: "Name is required." });
      }));

    it("returns error when name exceeds max length", () =>
      withTestTransaction(async () => {
        const longName = "A".repeat(MAX_NAME_LENGTH + 1);
        const result = await createGuestAgentAction(longName, VALID_EMAIL);
        expect(result).toEqual({
          success: false,
          error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        });
      }));

    it("returns error when email is empty", () =>
      withTestTransaction(async () => {
        const result = await createGuestAgentAction(VALID_NAME, "");
        expect(result).toEqual({ success: false, error: "Email is required." });
      }));

    it("returns error when email is too long", () =>
      withTestTransaction(async () => {
        const longEmail = "a".repeat(MAX_EMAIL_LENGTH) + "@example.com";
        const result = await createGuestAgentAction(VALID_NAME, longEmail);
        expect(result).toEqual({ success: false, error: "Email is too long." });
      }));

    it("returns error for invalid email format", () =>
      withTestTransaction(async () => {
        const result = await createGuestAgentAction(VALID_NAME, "not-an-email");
        expect(result).toEqual({
          success: false,
          error: "Please enter a valid email address.",
        });
      }));

    it("creates a guest agent and returns its id", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `guest-${Date.now()}@example.com`;
        const result = await createGuestAgentAction(VALID_NAME, uniqueEmail);

        expect(result.success).toBe(true);
        expect(result.agentId).toBeDefined();

        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.email, uniqueEmail.toLowerCase()));
        expect(agent).toBeDefined();
        expect(agent.name).toBe(VALID_NAME);
        expect(agent.passwordHash).toBeNull();
        expect((agent.metadata as Record<string, unknown>).noSignin).toBe(true);
      }));

    it("normalizes email to lowercase", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `GUEST-${Date.now()}@Example.COM`;
        const result = await createGuestAgentAction(VALID_NAME, uniqueEmail);

        expect(result.success).toBe(true);

        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.email, uniqueEmail.toLowerCase().trim()));
        expect(agent).toBeDefined();
      }));

    it("trims name before storing", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `guest-trim-${Date.now()}@example.com`;
        const result = await createGuestAgentAction("  Trimmed Name  ", uniqueEmail);

        expect(result.success).toBe(true);

        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.agentId!));
        expect(agent.name).toBe("Trimmed Name");
      }));

    it("returns existing agent id if email already exists", () =>
      withTestTransaction(async (db) => {
        const existing = await createTestAgent(db, { email: "existing-guest@example.com" });

        const result = await createGuestAgentAction(VALID_NAME, "existing-guest@example.com");
        expect(result.success).toBe(true);
        expect(result.agentId).toBe(existing.id);
      }));

    it("stores stripeCustomerId in metadata when provided", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `guest-stripe-${Date.now()}@example.com`;
        const result = await createGuestAgentAction(VALID_NAME, uniqueEmail, "cus_test_123");

        expect(result.success).toBe(true);

        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.agentId!));
        const meta = agent.metadata as Record<string, unknown>;
        expect(meta.stripeCustomerId).toBe("cus_test_123");
      }));
  });

  // ===========================================================================
  // findGuestByEmailAction
  // ===========================================================================

  describe("findGuestByEmailAction", () => {
    it("returns null for empty email", () =>
      withTestTransaction(async () => {
        const result = await findGuestByEmailAction("");
        expect(result).toBeNull();
      }));

    it("returns null for whitespace email", () =>
      withTestTransaction(async () => {
        const result = await findGuestByEmailAction("   ");
        expect(result).toBeNull();
      }));

    it("returns null when no agent with email exists", () =>
      withTestTransaction(async () => {
        const result = await findGuestByEmailAction("nonexistent@example.com");
        expect(result).toBeNull();
      }));

    it("returns null when agent exists but is not a guest", () =>
      withTestTransaction(async (db) => {
        await createTestAgent(db, {
          email: "regular@example.com",
          metadata: {},
        });

        const result = await findGuestByEmailAction("regular@example.com");
        expect(result).toBeNull();
      }));

    it("returns guest agent when it exists with noSignin flag", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `find-guest-${Date.now()}@example.com`;
        await createGuestAgentAction("Found Guest", uniqueEmail);

        const result = await findGuestByEmailAction(uniqueEmail);
        expect(result).not.toBeNull();
        expect(result?.name).toBe("Found Guest");
        expect(result?.email).toBe(uniqueEmail.toLowerCase());
        expect(result?.metadata.noSignin).toBe(true);
      }));

    it("normalizes email to lowercase for lookup", () =>
      withTestTransaction(async (db) => {
        const uniqueEmail = `find-guest-upper-${Date.now()}@example.com`;
        await createGuestAgentAction("Upper Guest", uniqueEmail);

        const result = await findGuestByEmailAction(uniqueEmail.toUpperCase());
        expect(result).not.toBeNull();
      }));
  });
});
