import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
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

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "test-msg-id" }),
}));

vi.mock("@/lib/email-templates", () => ({
  verificationEmail: vi.fn(() => ({ subject: "Verify", html: "<p>verify</p>", text: "verify" })),
  systemNotificationEmail: vi.fn(() => ({ subject: "Notice", html: "<p>notice</p>", text: "notice" })),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { updateProfileAction, type UpdateProfileInput } from "../settings";

// =============================================================================
// Constants
// =============================================================================

const MAX_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 50;
const MAX_BIO_LENGTH = 500;
const MAX_PHONE_LENGTH = 50;

const VALID_INPUT: UpdateProfileInput = {
  name: "Alice Johnson",
  username: "alice_j",
  email: "settings-test-unique@test.local",
  bio: "River enthusiast and community organizer.",
  phone: "555-0123",
};

// =============================================================================
// Tests
// =============================================================================

describe("updateProfileAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  it("returns error when not authenticated (null session)", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      const result = await updateProfileAction(VALID_INPUT);

      expect(result).toEqual({
        success: false,
        error: "You must be logged in to update your profile.",
      });
    }));

  it("returns error when session has no user id", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue({ user: {} } as ReturnType<typeof mockAuthSession>);

      const result = await updateProfileAction(VALID_INPUT);

      expect(result).toEqual({
        success: false,
        error: "You must be logged in to update your profile.",
      });
    }));

  // ---------------------------------------------------------------------------
  // Name validation
  // ---------------------------------------------------------------------------

  it("returns error when name is empty", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, name: "" });

      expect(result).toEqual({
        success: false,
        error: "Name is required.",
      });
    }));

  it("returns error when name is only whitespace", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, name: "   " });

      expect(result).toEqual({
        success: false,
        error: "Name is required.",
      });
    }));

  it("returns error when name exceeds max length", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const longName = "a".repeat(MAX_NAME_LENGTH + 1);
      const result = await updateProfileAction({ ...VALID_INPUT, name: longName });

      expect(result).toEqual({
        success: false,
        error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      });
    }));

  // ---------------------------------------------------------------------------
  // Username validation
  // ---------------------------------------------------------------------------

  it("returns error when username is empty", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, username: "" });

      expect(result).toEqual({
        success: false,
        error: "Username is required.",
      });
    }));

  it("returns error when username is only whitespace", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, username: "   " });

      expect(result).toEqual({
        success: false,
        error: "Username is required.",
      });
    }));

  it("returns error when username exceeds max length", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const longUsername = "a".repeat(MAX_USERNAME_LENGTH + 1);
      const result = await updateProfileAction({ ...VALID_INPUT, username: longUsername });

      expect(result).toEqual({
        success: false,
        error: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`,
      });
    }));

  it("returns error when username has invalid characters", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, username: "alice @home!" });

      expect(result).toEqual({
        success: false,
        error: "Username may only contain letters, numbers, periods, underscores, and hyphens.",
      });
    }));

  it.each(["user name", "user@name", "alice!", "hello#world", "a b"])(
    "rejects username with invalid characters: %s",
    (badUsername) =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateProfileAction({ ...VALID_INPUT, username: badUsername });

        expect(result.success).toBe(false);
        expect(result.error).toBe(
          "Username may only contain letters, numbers, periods, underscores, and hyphens."
        );
      })
  );

  it.each(["alice_j", "Bob.Smith", "user-123", "Agent007", "a.b-c_d"])(
    "accepts valid username: %s",
    (goodUsername) =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateProfileAction({ ...VALID_INPUT, username: goodUsername });

        expect(result.success).toBe(true);
      })
  );

  // ---------------------------------------------------------------------------
  // Email validation
  // ---------------------------------------------------------------------------

  it("returns error when email is empty", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, email: "" });

      expect(result).toEqual({
        success: false,
        error: "Email is required.",
      });
    }));

  it("returns error when email is only whitespace", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, email: "   " });

      expect(result).toEqual({
        success: false,
        error: "Email is required.",
      });
    }));

  it("returns error when email is invalid format", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, email: "not-an-email" });

      expect(result).toEqual({
        success: false,
        error: "Please enter a valid email address.",
      });
    }));

  it.each(["missing-at.com", "@no-local.com", "no-domain@", "spaces in@email.com"])(
    "rejects invalid email: %s",
    (badEmail) =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateProfileAction({ ...VALID_INPUT, email: badEmail });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/email/i);
      })
  );

  // ---------------------------------------------------------------------------
  // Bio validation
  // ---------------------------------------------------------------------------

  it("returns error when bio exceeds max length", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const longBio = "x".repeat(MAX_BIO_LENGTH + 1);
      const result = await updateProfileAction({ ...VALID_INPUT, bio: longBio });

      expect(result).toEqual({
        success: false,
        error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`,
      });
    }));

  it("allows bio at exactly max length", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const maxBio = "x".repeat(MAX_BIO_LENGTH);
      const result = await updateProfileAction({ ...VALID_INPUT, bio: maxBio });

      expect(result.success).toBe(true);
    }));

  it("allows empty bio", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, bio: "" });

      expect(result.success).toBe(true);
    }));

  // ---------------------------------------------------------------------------
  // Phone validation
  // ---------------------------------------------------------------------------

  it("returns error when phone exceeds max length", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const longPhone = "5".repeat(MAX_PHONE_LENGTH + 1);
      const result = await updateProfileAction({ ...VALID_INPUT, phone: longPhone });

      expect(result).toEqual({
        success: false,
        error: `Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`,
      });
    }));

  it("allows empty phone", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({ ...VALID_INPUT, phone: "" });

      expect(result.success).toBe(true);
    }));

  // ---------------------------------------------------------------------------
  // Successful update — verify actual DB state
  // ---------------------------------------------------------------------------

  it("updates agent row in DB with correct values", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb, {
        name: "Old Name",
        email: "old@test.local",
        metadata: { existingField: "preserved" },
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({
        name: "Alice Johnson",
        username: "alice_j",
        email: "settings-dbcheck@test.local",
        bio: "Community organizer.",
        phone: "555-0123",
      });

      expect(result).toEqual({ success: true });

      // Verify DB state
      const [updated] = await txDb
        .select()
        .from(agents)
        .where(eq(agents.id, user.id));

      expect(updated.name).toBe("Alice Johnson");
      expect(updated.email).toBe("settings-dbcheck@test.local");
      expect(updated.description).toBe("Community organizer.");

      const meta = updated.metadata as Record<string, unknown>;
      expect(meta.username).toBe("alice_j");
      expect(meta.phone).toBe("555-0123");
      expect(meta.bio).toBe("Community organizer.");
      // Existing metadata should be preserved
      expect(meta.existingField).toBe("preserved");
    }));

  it("normalizes email to lowercase", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({
        ...VALID_INPUT,
        email: "Settings-Normalize@Test.LOCAL",
      });

      expect(result.success).toBe(true);

      const [updated] = await txDb
        .select()
        .from(agents)
        .where(eq(agents.id, user.id));

      expect(updated.email).toBe("settings-normalize@test.local");
    }));

  it("trims whitespace from all input fields", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({
        name: "  Alice Johnson  ",
        username: "  alice_j  ",
        email: "  settings-trim@test.local  ",
        bio: "  Some bio  ",
        phone: "  555-0123  ",
      });

      expect(result.success).toBe(true);

      const [updated] = await txDb
        .select()
        .from(agents)
        .where(eq(agents.id, user.id));

      expect(updated.name).toBe("Alice Johnson");
      expect(updated.email).toBe("settings-trim@test.local");
      const meta = updated.metadata as Record<string, unknown>;
      expect(meta.username).toBe("alice_j");
      expect(meta.bio).toBe("Some bio");
      expect(meta.phone).toBe("555-0123");
    }));

  it("handles null metadata gracefully", () =>
    withTestTransaction(async (txDb) => {
      // Insert agent with null-ish metadata
      const user = await createTestAgent(txDb, { metadata: {} });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction(VALID_INPUT);

      expect(result.success).toBe(true);
    }));

  // ---------------------------------------------------------------------------
  // Duplicate email (unique constraint)
  // ---------------------------------------------------------------------------

  it("returns 'already in use' error on duplicate email", () =>
    withTestTransaction(async (txDb) => {
      const user = await createTestAgent(txDb, { email: "original@test.local" });
      const other = await createTestAgent(txDb, { email: "taken@test.local" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await updateProfileAction({
        ...VALID_INPUT,
        email: "taken@test.local",
      });

      expect(result).toEqual({
        success: false,
        error: "That email is already in use.",
      });
    }));
});
