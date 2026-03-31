/**
 * Tests for Group-Protected Access Flow
 *
 * Tests the password challenge → membership grant pipeline.
 * Covers: password verification, membership creation, expiration enforcement,
 * renewal, revocation, authorization checks, and rate limiting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

const mockAuth = vi.fn();
const mockHeaders = vi.fn();
const mockRateLimit = vi.fn();
const mockVerify = vi.fn();

// Mock auth
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

// Mock rate limiter
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

// Mock bcrypt verify
vi.mock("@node-rs/bcrypt", () => ({
  verify: (...args: unknown[]) => mockVerify(...args),
}));

// Mock DB
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbExecute = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    execute: (...args: unknown[]) => mockDbExecute(...args),
    query: {
      ledger: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: {
    id: "agents.id",
    name: "agents.name",
    groupPasswordHash: "agents.groupPasswordHash",
    deletedAt: "agents.deletedAt",
  },
  ledger: {
    id: "ledger.id",
    verb: "ledger.verb",
    subjectId: "ledger.subjectId",
    objectId: "ledger.objectId",
    objectType: "ledger.objectType",
    isActive: "ledger.isActive",
    expiresAt: "ledger.expiresAt",
    role: "ledger.role",
    metadata: "ledger.metadata",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, val) => ({ type: "eq", val })),
  and: vi.fn((...args) => ({ type: "and", args })),
  or: vi.fn((...args) => ({ type: "or", args })),
  sql: vi.fn(),
  isNull: vi.fn(() => ({ type: "isNull" })),
}));

import {
  challengeGroupAccess,
  revokeGroupMembership,
  renewGroupMembership,
  checkGroupMembership,
} from "@/app/actions/group-access";

// =============================================================================
// Test fixtures
// =============================================================================

const ALICE_ID = "a1111111-1111-1111-9111-111111111111";
const BOB_ID = "b2222222-2222-2222-9222-222222222222";
const GROUP_ID = "c3333333-3333-3333-9333-333333333333";

const LOCKED_GROUP = {
  id: GROUP_ID,
  name: "Secret Garden Club",
  groupPasswordHash: "$2b$12$mockhashedpassword",
};

const OPEN_GROUP = {
  id: GROUP_ID,
  name: "Open Group",
  groupPasswordHash: null,
};

const MOCK_HEADERS = {
  get: vi.fn((key: string) => {
    if (key === "x-forwarded-for") return "127.0.0.1";
    if (key === "x-real-ip") return "127.0.0.1";
    return null;
  }),
};

// =============================================================================
// Helpers
// =============================================================================

function authenticatedAs(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId } });
  mockHeaders.mockResolvedValue(MOCK_HEADERS);
  mockRateLimit.mockResolvedValue({ success: true, remaining: 4, resetMs: 60000 });
}

function unauthenticated() {
  mockAuth.mockResolvedValue(null);
  mockHeaders.mockResolvedValue(MOCK_HEADERS);
}

/**
 * Set up sequential mock responses for chained db.select() calls.
 * Each response in the array corresponds to one db.select()...limit(1) call.
 */
function setupSelectSequence(responses: unknown[][]) {
  let callIndex = 0;

  mockDbSelect.mockImplementation(() => {
    const response = responses[callIndex] ?? [];
    callIndex++;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue(response),
        }),
      }),
    };
  });
}

function setupInsertReturning(returnValue: unknown[]) {
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockReturnValue(returnValue),
    }),
  });
}

function setupInsertNoReturn() {
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue(undefined),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("Group-Protected Access Flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- challengeGroupAccess ---

  describe("challengeGroupAccess", () => {
    it("requires authentication", async () => {
      unauthenticated();

      const result = await challengeGroupAccess(GROUP_ID, "secret123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ALICE_ID);

      const result = await challengeGroupAccess("not-a-uuid", "secret123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group identifier.");
    });

    it("requires a non-empty password", async () => {
      authenticatedAs(ALICE_ID);

      const result = await challengeGroupAccess(GROUP_ID, "");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Password is required.");
    });

    it("returns error when group not found", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [], // group not found
      ]);

      const result = await challengeGroupAccess(GROUP_ID, "secret123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found.");
    });

    it("rejects access to group without password protection", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [OPEN_GROUP], // group found, no password hash
      ]);

      const result = await challengeGroupAccess(GROUP_ID, "secret123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Group does not require password access.");
    });

    it("returns existing membership if user is already a member", async () => {
      authenticatedAs(ALICE_ID);
      const futureDate = new Date(Date.now() + 86400000);
      setupSelectSequence([
        [LOCKED_GROUP], // group found
        [{ id: "existing-membership-id", role: "member", expiresAt: futureDate }], // existing active membership
      ]);

      const result = await challengeGroupAccess(GROUP_ID, "secret123");
      expect(result.success).toBe(true);
      expect(result.membershipId).toBe("existing-membership-id");
      // verify() should NOT have been called since we short-circuit
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it("rejects invalid password", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [LOCKED_GROUP], // group found
        [],             // no existing membership
      ]);
      mockVerify.mockResolvedValue(false);

      const result = await challengeGroupAccess(GROUP_ID, "wrong-password");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group password.");
      expect(mockVerify).toHaveBeenCalledWith("wrong-password", LOCKED_GROUP.groupPasswordHash);
    });

    it("grants membership on valid password and returns entry details", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [LOCKED_GROUP], // group found
        [],             // no existing membership
      ]);
      mockVerify.mockResolvedValue(true);
      setupInsertReturning([{ id: "new-membership-id" }]);

      const result = await challengeGroupAccess(GROUP_ID, "correct-password");
      expect(result.success).toBe(true);
      expect(result.membershipId).toBe("new-membership-id");
      expect(result.expiresAt).toBeDefined();

      // Verify the expiration is ~30 days from now
      const expiresAt = new Date(result.expiresAt!);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const tolerance = 5000; // 5s tolerance for test timing
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(thirtyDaysMs - tolerance);
      expect(expiresAt.getTime() - Date.now()).toBeLessThan(thirtyDaysMs + tolerance);

      expect(mockVerify).toHaveBeenCalledWith("correct-password", LOCKED_GROUP.groupPasswordHash);
    });

    it("enforces rate limiting", async () => {
      mockAuth.mockResolvedValue({ user: { id: ALICE_ID } });
      mockHeaders.mockResolvedValue(MOCK_HEADERS);
      mockRateLimit.mockResolvedValue({ success: false, remaining: 0, resetMs: 30000 });

      const result = await challengeGroupAccess(GROUP_ID, "password");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Too many attempts");
      expect(result.error).toContain("30 seconds");
    });
  });

  // --- revokeGroupMembership ---

  describe("revokeGroupMembership", () => {
    it("requires authentication", async () => {
      unauthenticated();

      const result = await revokeGroupMembership(GROUP_ID, ALICE_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ALICE_ID);

      const result = await revokeGroupMembership("invalid", ALICE_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group identifier.");
    });

    it("validates memberId is a UUID", async () => {
      authenticatedAs(ALICE_ID);

      const result = await revokeGroupMembership(GROUP_ID, "invalid");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid member identifier.");
    });

    it("allows a member to revoke their own membership", async () => {
      authenticatedAs(ALICE_ID);
      // isGroupAdmin check: no admin entry found, but it's self-revocation so OK
      setupSelectSequence([
        [], // isGroupAdmin → not admin (but user === member, so allowed)
      ]);
      mockDbExecute.mockResolvedValue(undefined);
      setupInsertNoReturn();

      const result = await revokeGroupMembership(GROUP_ID, ALICE_ID);
      expect(result.success).toBe(true);
    });

    it("allows admin to revoke another member's membership", async () => {
      authenticatedAs(ALICE_ID);
      // isGroupAdmin check: Alice is admin
      setupSelectSequence([
        [{ id: "admin-entry" }], // isGroupAdmin → is admin
      ]);
      mockDbExecute.mockResolvedValue(undefined);
      setupInsertNoReturn();

      const result = await revokeGroupMembership(GROUP_ID, BOB_ID);
      expect(result.success).toBe(true);
    });

    it("denies non-admin revoking another member", async () => {
      authenticatedAs(ALICE_ID);
      // isGroupAdmin check: Alice is NOT admin
      setupSelectSequence([
        [], // isGroupAdmin → not admin
      ]);

      const result = await revokeGroupMembership(GROUP_ID, BOB_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Not authorized to revoke this membership.");
    });
  });

  // --- renewGroupMembership ---

  describe("renewGroupMembership", () => {
    it("requires authentication", async () => {
      unauthenticated();

      const result = await renewGroupMembership(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ALICE_ID);

      const result = await renewGroupMembership("bad-id");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group identifier.");
    });

    it("requires a prior password-challenge membership to renew", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [], // no prior membership with grantType=password_challenge
      ]);

      const result = await renewGroupMembership(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No prior membership found");
    });

    it("renews membership when prior password challenge exists", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [{ id: "old-membership-id" }], // prior password-challenge membership found
      ]);
      mockDbExecute.mockResolvedValue(undefined); // deactivate old memberships
      setupInsertReturning([{ id: "renewed-membership-id" }]);

      const result = await renewGroupMembership(GROUP_ID);
      expect(result.success).toBe(true);
      expect(result.membershipId).toBe("renewed-membership-id");
      expect(result.expiresAt).toBeDefined();
    });
  });

  // --- checkGroupMembership ---

  describe("checkGroupMembership", () => {
    it("returns not-member for unauthenticated users", async () => {
      unauthenticated();

      const result = await checkGroupMembership(GROUP_ID);
      expect(result.isMember).toBe(false);
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ALICE_ID);

      const result = await checkGroupMembership("invalid");
      expect(result.isMember).toBe(false);
    });

    it("returns false when no active membership exists", async () => {
      authenticatedAs(ALICE_ID);
      setupSelectSequence([
        [], // no active membership
      ]);

      const result = await checkGroupMembership(GROUP_ID);
      expect(result.isMember).toBe(false);
    });

    it("returns membership details when active membership exists", async () => {
      authenticatedAs(ALICE_ID);
      const expiresAt = new Date(Date.now() + 86400000);
      setupSelectSequence([
        [{ id: "membership-1", role: "member", expiresAt }],
      ]);

      const result = await checkGroupMembership(GROUP_ID);
      expect(result.isMember).toBe(true);
      expect(result.membershipId).toBe("membership-1");
      expect(result.role).toBe("member");
      expect(result.expiresAt).toBe(expiresAt.toISOString());
    });
  });

  // --- isGroupMember helper from permissions ---

  describe("isGroupMember (permissions helper)", () => {
    it("is exported from permissions module", async () => {
      // Dynamic import to test the export exists
      const permissions = await import("@/lib/permissions");
      expect(permissions.isGroupMember).toBeDefined();
      expect(typeof permissions.isGroupMember).toBe("function");
    });
  });
});
