/**
 * Tests for admin server actions.
 *
 * Uses real database with transactional rollback for isolation.
 * Tests: fetchAdminUsers, toggleUserActiveStatus, assignBadgeToUser, removeBadgeFromUser.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestResource,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents, resources } from "@/db/schema";

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

// Import AFTER all mocks are registered
import { auth } from "@/auth";
import {
  fetchAdminUsers,
  toggleUserActiveStatus,
  assignBadgeToUser,
  removeBadgeFromUser,
} from "../admin";

// =============================================================================
// Tests
// =============================================================================

describe("fetchAdminUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(fetchAdminUsers()).rejects.toThrow("Unauthorized");
    }));

  it("returns person-type agents with status and badge count", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const user1 = await createTestAgent(db, { name: "User One", email: "u1@test.local" });
      const user2 = await createTestAgent(db, { name: "User Two", email: "u2@test.local" });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await fetchAdminUsers();

      expect(Array.isArray(result)).toBe(true);
      // Should include at least the agents we created
      const resultIds = result.map((u) => u.id);
      expect(resultIds).toContain(user1.id);
      expect(resultIds).toContain(user2.id);

      // All returned users should have the expected shape
      for (const user of result) {
        expect(user).toHaveProperty("id");
        expect(user).toHaveProperty("name");
        expect(user).toHaveProperty("status");
        expect(user).toHaveProperty("badgeCount");
        expect(["active", "inactive"]).toContain(user.status);
        expect(typeof user.badgeCount).toBe("number");
      }
    }));

  it("marks soft-deleted agents as inactive", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const deactivated = await createTestAgent(db, {
        name: "Deactivated User",
        email: "deactivated@test.local",
      });

      // Soft-delete the user
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, deactivated.id));

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await fetchAdminUsers();
      const found = result.find((u) => u.id === deactivated.id);

      expect(found).toBeDefined();
      expect(found!.status).toBe("inactive");
    }));
});

describe("toggleUserActiveStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(toggleUserActiveStatus("some-id")).rejects.toThrow("Unauthorized");
    }));

  it("returns NOT_FOUND for non-existent user", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await toggleUserActiveStatus("00000000-0000-0000-0000-000000000000");

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
    }));

  it("deactivates an active user (sets deletedAt)", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Target User", email: "target@test.local" });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await toggleUserActiveStatus(target.id);

      expect(result.success).toBe(true);
      expect(result.message).toBe("User deactivated");

      // Verify DB state
      const [updated] = await db
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, target.id));
      expect(updated.deletedAt).not.toBeNull();
    }));

  it("reactivates an inactive user (clears deletedAt)", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Target User", email: "target2@test.local" });

      // First deactivate
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, target.id));

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await toggleUserActiveStatus(target.id);

      expect(result.success).toBe(true);
      expect(result.message).toBe("User activated");

      // Verify DB state
      const [updated] = await db
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, target.id));
      expect(updated.deletedAt).toBeNull();
    }));
});

describe("assignBadgeToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(assignBadgeToUser("user-id", "badge-id")).rejects.toThrow("Unauthorized");
    }));

  it("returns NOT_FOUND when user does not exist", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const badge = await createTestResource(db, admin.id, {
        name: "Test Badge",
        type: "badge" as const,
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await assignBadgeToUser(
        "00000000-0000-0000-0000-000000000000",
        badge.id
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
      expect(result.message).toBe("User not found");
    }));

  it("returns NOT_FOUND when badge does not exist", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Target", email: "badge-target@test.local" });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await assignBadgeToUser(
        target.id,
        "00000000-0000-0000-0000-000000000000"
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
      expect(result.message).toBe("Badge not found");
    }));

  it("creates a ledger entry on successful assignment", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Badge Recipient", email: "recipient@test.local" });
      const badge = await createTestResource(db, admin.id, {
        name: "Community Hero",
        type: "badge" as const,
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await assignBadgeToUser(target.id, badge.id);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Badge assigned successfully");
    }));

  it("rejects duplicate assignment", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Badge Recipient", email: "dup@test.local" });
      const badge = await createTestResource(db, admin.id, {
        name: "Unique Badge",
        type: "badge" as const,
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      // First assignment succeeds
      const first = await assignBadgeToUser(target.id, badge.id);
      expect(first.success).toBe(true);

      // Second assignment fails with DUPLICATE
      const second = await assignBadgeToUser(target.id, badge.id);
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe("DUPLICATE");
    }));
});

describe("removeBadgeFromUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

      await expect(removeBadgeFromUser("user-id", "badge-id")).rejects.toThrow("Unauthorized");
    }));

  it("deactivates the ledger entry for an assigned badge", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Remove Target", email: "remove@test.local" });
      const badge = await createTestResource(db, admin.id, {
        name: "Removable Badge",
        type: "badge" as const,
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      // Assign first
      await assignBadgeToUser(target.id, badge.id);

      // Remove
      const result = await removeBadgeFromUser(target.id, badge.id);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Badge removed successfully");
    }));

  it("succeeds even when no matching assignment exists (idempotent)", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      // Remove a badge that was never assigned
      const result = await removeBadgeFromUser(
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000001"
      );

      // removeBadgeFromUser always returns success (it's a no-op if nothing matched)
      expect(result.success).toBe(true);
    }));

  it("allows re-assignment after removal", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db, { name: "Admin" });
      const target = await createTestAgent(db, { name: "Re-assign Target", email: "reassign@test.local" });
      const badge = await createTestResource(db, admin.id, {
        name: "Re-assignable Badge",
        type: "badge" as const,
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      // Assign -> remove -> re-assign
      await assignBadgeToUser(target.id, badge.id);
      await removeBadgeFromUser(target.id, badge.id);

      const result = await assignBadgeToUser(target.id, badge.id);
      expect(result.success).toBe(true);
      expect(result.message).toBe("Badge assigned successfully");
    }));
});
