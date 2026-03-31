/**
 * Tests for Group Admin Password Management
 *
 * Tests the setGroupPassword and removeGroupPassword server actions.
 * Covers: password hashing & storage, password removal, authorization
 * enforcement (admin-only), input validation, and group existence checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

const mockAuth = vi.fn();
const mockHash = vi.fn();

// Mock auth
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

// Mock bcrypt hash
vi.mock("@node-rs/bcrypt", () => ({
  hash: (...args: unknown[]) => mockHash(...args),
}));

// Mock DB
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbExecute = vi.fn();
const mockDbUpdate = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    execute: (...args: unknown[]) => mockDbExecute(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  agents: {
    id: "agents.id",
    name: "agents.name",
    groupPasswordHash: "agents.groupPasswordHash",
    deletedAt: "agents.deletedAt",
    updatedAt: "agents.updatedAt",
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
  setGroupPassword,
  removeGroupPassword,
} from "@/app/actions/group-admin";

// =============================================================================
// Test fixtures
// =============================================================================

const ADMIN_ID = "a1111111-1111-1111-9111-111111111111";
const REGULAR_USER_ID = "b2222222-2222-2222-9222-222222222222";
const GROUP_ID = "c3333333-3333-3333-9333-333333333333";
const HASHED_PASSWORD = "$2b$12$newlyhashedpassword";

const EXISTING_GROUP = {
  id: GROUP_ID,
};

// =============================================================================
// Helpers
// =============================================================================

function authenticatedAs(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId } });
}

function unauthenticated() {
  mockAuth.mockResolvedValue(null);
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

function setupUpdateChain() {
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("Group Admin Password Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- setGroupPassword ---

  describe("setGroupPassword", () => {
    it("requires authentication", async () => {
      unauthenticated();

      const result = await setGroupPassword(GROUP_ID, "newpassword123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ADMIN_ID);

      const result = await setGroupPassword("not-a-uuid", "newpassword123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group identifier.");
    });

    it("rejects empty password", async () => {
      authenticatedAs(ADMIN_ID);

      const result = await setGroupPassword(GROUP_ID, "");
      expect(result.success).toBe(false);
      expect(result.error).toContain("at least");
    });

    it("rejects password shorter than minimum length", async () => {
      authenticatedAs(ADMIN_ID);

      const result = await setGroupPassword(GROUP_ID, "short");
      expect(result.success).toBe(false);
      expect(result.error).toContain("at least 8 characters");
    });

    it("rejects password longer than maximum length", async () => {
      authenticatedAs(ADMIN_ID);

      const longPassword = "a".repeat(73);
      const result = await setGroupPassword(GROUP_ID, longPassword);
      expect(result.success).toBe(false);
      expect(result.error).toContain("at most 72 characters");
    });

    it("rejects non-admin users", async () => {
      authenticatedAs(REGULAR_USER_ID);
      setupSelectSequence([
        [], // isGroupAdmin -> not admin
      ]);

      const result = await setGroupPassword(GROUP_ID, "newpassword123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Only group admins can manage the group password.");
    });

    it("returns error when group not found", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "admin-entry" }], // isGroupAdmin -> is admin
        [],                      // group not found
      ]);

      const result = await setGroupPassword(GROUP_ID, "newpassword123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found.");
    });

    it("hashes and stores the password for admin users", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "admin-entry" }], // isGroupAdmin -> is admin
        [EXISTING_GROUP],        // group found
      ]);
      mockHash.mockResolvedValue(HASHED_PASSWORD);
      setupUpdateChain();

      const result = await setGroupPassword(GROUP_ID, "newpassword123");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockHash).toHaveBeenCalledWith("newpassword123", 12);
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("passes the correct bcrypt cost factor when hashing", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "admin-entry" }],
        [EXISTING_GROUP],
      ]);
      mockHash.mockResolvedValue(HASHED_PASSWORD);
      setupUpdateChain();

      await setGroupPassword(GROUP_ID, "anotherpassword");

      // Verify bcrypt cost factor is 12
      expect(mockHash).toHaveBeenCalledWith("anotherpassword", 12);
    });
  });

  // --- removeGroupPassword ---

  describe("removeGroupPassword", () => {
    it("requires authentication", async () => {
      unauthenticated();

      const result = await removeGroupPassword(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
    });

    it("validates groupId is a UUID", async () => {
      authenticatedAs(ADMIN_ID);

      const result = await removeGroupPassword("invalid-id");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid group identifier.");
    });

    it("rejects non-admin users", async () => {
      authenticatedAs(REGULAR_USER_ID);
      setupSelectSequence([
        [], // isGroupAdmin -> not admin
      ]);

      const result = await removeGroupPassword(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Only group admins can manage the group password.");
    });

    it("returns error when group not found", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "admin-entry" }], // isGroupAdmin -> is admin
        [],                      // group not found
      ]);

      const result = await removeGroupPassword(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found.");
    });

    it("clears the password hash for admin users", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "admin-entry" }], // isGroupAdmin -> is admin
        [EXISTING_GROUP],        // group found
      ]);
      setupUpdateChain();

      const result = await removeGroupPassword(GROUP_ID);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockDbUpdate).toHaveBeenCalled();
      // hash should NOT have been called since we're removing
      expect(mockHash).not.toHaveBeenCalled();
    });
  });

  // --- Authorization edge cases ---

  describe("Authorization edge cases", () => {
    it("admin with moderator role can set password", async () => {
      authenticatedAs(ADMIN_ID);
      // The isGroupAdmin query matches role=admin OR role=moderator,
      // so a moderator entry will satisfy the check
      setupSelectSequence([
        [{ id: "moderator-entry" }], // isGroupAdmin -> moderator role counts
        [EXISTING_GROUP],
      ]);
      mockHash.mockResolvedValue(HASHED_PASSWORD);
      setupUpdateChain();

      const result = await setGroupPassword(GROUP_ID, "moderator-sets-pw");
      expect(result.success).toBe(true);
    });

    it("admin with moderator role can remove password", async () => {
      authenticatedAs(ADMIN_ID);
      setupSelectSequence([
        [{ id: "moderator-entry" }],
        [EXISTING_GROUP],
      ]);
      setupUpdateChain();

      const result = await removeGroupPassword(GROUP_ID);
      expect(result.success).toBe(true);
    });

    it("unauthenticated user cannot set password", async () => {
      mockAuth.mockResolvedValue(null);

      const result = await setGroupPassword(GROUP_ID, "password123");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
      expect(mockDbSelect).not.toHaveBeenCalled();
    });

    it("unauthenticated user cannot remove password", async () => {
      mockAuth.mockResolvedValue(null);

      const result = await removeGroupPassword(GROUP_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication required.");
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });
});
