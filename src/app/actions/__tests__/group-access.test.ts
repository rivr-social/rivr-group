/**
 * Tests for group-access server actions.
 *
 * Uses real database via withTestTransaction — every test runs inside a
 * transaction that rolls back, giving perfect isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createMembership } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { eq, and } from "drizzle-orm";
import { ledger, agents } from "@/db/schema";
import { hash } from "@node-rs/bcrypt";

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

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
}));

import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  challengeGroupAccess,
  revokeGroupMembership,
  renewGroupMembership,
  checkGroupMembership,
} from "../group-access";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVALID_UUID = "not-a-valid-uuid";
const TEST_PASSWORD = "correct-password-123";
const BCRYPT_COST = 12;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group-access actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
  });

  // =========================================================================
  // challengeGroupAccess
  // =========================================================================

  describe("challengeGroupAccess", () => {
    it("returns error when user is unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await challengeGroupAccess(
          "22222222-2222-4222-8222-222222222222",
          "password"
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error for invalid UUID group identifier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await challengeGroupAccess(INVALID_UUID, "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group identifier.");
      }));

    it("returns error when password is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await challengeGroupAccess(
          "22222222-2222-4222-8222-222222222222",
          ""
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Password is required.");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({
          success: false,
          resetMs: 30_000,
        });

        const result = await challengeGroupAccess(
          "22222222-2222-4222-8222-222222222222",
          "password"
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many attempts");
      }));

    it("returns error when group is not found", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const nonExistentId = "99999999-9999-4999-8999-999999999999";
        const result = await challengeGroupAccess(nonExistentId, "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Group not found.");
      }));

    it("returns error when group has no password hash", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db); // no password hash
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await challengeGroupAccess(group.id, "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Group does not require password access.");
      }));

    it("returns existing membership when user is already a member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const passwordHash = await hash(TEST_PASSWORD, BCRYPT_COST);
        const group = await createTestGroup(db, { groupPasswordHash: passwordHash });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Create existing membership
        const membership = await createMembership(db, user.id, group.id, "member");

        const result = await challengeGroupAccess(group.id, TEST_PASSWORD);

        expect(result.success).toBe(true);
        expect(result.membershipId).toBe(membership.id);
      }));

    it("returns error when password is incorrect", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const passwordHash = await hash(TEST_PASSWORD, BCRYPT_COST);
        const group = await createTestGroup(db, { groupPasswordHash: passwordHash });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await challengeGroupAccess(group.id, "wrong-password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group password.");
      }));

    it("creates membership ledger entry on valid password", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const passwordHash = await hash(TEST_PASSWORD, BCRYPT_COST);
        const group = await createTestGroup(db, { groupPasswordHash: passwordHash });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await challengeGroupAccess(group.id, TEST_PASSWORD);

        expect(result.success).toBe(true);
        expect(result.membershipId).toBeDefined();
        expect(result.expiresAt).toBeDefined();

        // Verify ledger entry in DB
        const [entry] = await db
          .select()
          .from(ledger)
          .where(eq(ledger.id, result.membershipId!));

        expect(entry).toBeDefined();
        expect(entry.verb).toBe("join");
        expect(entry.subjectId).toBe(user.id);
        expect(entry.objectId).toBe(group.id);
        expect(entry.role).toBe("member");
        expect(entry.isActive).toBe(true);
        expect(entry.expiresAt).toBeDefined();
        const meta = entry.metadata as Record<string, unknown>;
        expect(meta.grantType).toBe("password_challenge");
        expect(meta.interactionType).toBe("membership");
      }));
  });

  // =========================================================================
  // revokeGroupMembership
  // =========================================================================

  describe("revokeGroupMembership", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await revokeGroupMembership(
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333"
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error for invalid group UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await revokeGroupMembership(INVALID_UUID, user.id);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group identifier.");
      }));

    it("returns error for invalid member UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await revokeGroupMembership(
          "22222222-2222-4222-8222-222222222222",
          INVALID_UUID
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid member identifier.");
      }));

    it("returns error when user is not self and not admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const otherUser = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await revokeGroupMembership(group.id, otherUser.id);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Not authorized to revoke this membership.");
      }));

    it("succeeds when revoking own membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        // Create a join membership
        await db.insert(ledger).values({
          verb: "join",
          subjectId: user.id,
          objectId: group.id,
          objectType: "agent",
          role: "member",
          isActive: true,
          metadata: { grantType: "password_challenge", interactionType: "membership" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await revokeGroupMembership(group.id, user.id);

        expect(result.success).toBe(true);

        // Verify the membership was deactivated
        const memberships = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.objectId, group.id),
              eq(ledger.verb, "join")
            )
          );
        const activeMemberships = memberships.filter((m) => m.isActive);
        expect(activeMemberships.length).toBe(0);

        // Verify audit entry was created
        const leaveEntries = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.objectId, group.id),
              eq(ledger.verb, "leave")
            )
          );
        expect(leaveEntries.length).toBe(1);
        const meta = leaveEntries[0].metadata as Record<string, unknown>;
        expect(meta.revokedMember).toBe(user.id);
        expect(meta.revokedBy).toBe(user.id);
      }));

    it("succeeds when admin revokes another member's membership", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const member = await createTestAgent(db);
        const group = await createTestGroup(db);

        // Create admin membership
        await createMembership(db, admin.id, group.id, "admin");
        // Create member membership via join
        await db.insert(ledger).values({
          verb: "join",
          subjectId: member.id,
          objectId: group.id,
          objectType: "agent",
          role: "member",
          isActive: true,
          metadata: { grantType: "password_challenge", interactionType: "membership" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await revokeGroupMembership(group.id, member.id);

        expect(result.success).toBe(true);

        // Verify audit entry was created with admin as revoker
        const leaveEntries = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, admin.id),
              eq(ledger.objectId, group.id),
              eq(ledger.verb, "leave")
            )
          );
        expect(leaveEntries.length).toBe(1);
        const meta = leaveEntries[0].metadata as Record<string, unknown>;
        expect(meta.revokedMember).toBe(member.id);
        expect(meta.revokedBy).toBe(admin.id);
      }));
  });

  // =========================================================================
  // renewGroupMembership
  // =========================================================================

  describe("renewGroupMembership", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await renewGroupMembership(
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await renewGroupMembership(INVALID_UUID);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group identifier.");
      }));

    it("returns error when no prior password-challenge membership exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await renewGroupMembership(group.id);

        expect(result.success).toBe(false);
        expect(result.error).toContain("No prior membership found");
      }));

    it("deactivates old membership and creates a new one on renewal", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Create a prior password-challenge membership (expired)
        const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await db.insert(ledger).values({
          verb: "join",
          subjectId: user.id,
          objectId: group.id,
          objectType: "agent",
          role: "member",
          isActive: true,
          expiresAt: expiredDate,
          metadata: {
            grantType: "password_challenge",
            interactionType: "membership",
          },
        });

        const result = await renewGroupMembership(group.id);

        expect(result.success).toBe(true);
        expect(result.membershipId).toBeDefined();
        expect(result.expiresAt).toBeDefined();

        // Verify the new membership was created
        const [newEntry] = await db
          .select()
          .from(ledger)
          .where(eq(ledger.id, result.membershipId!));

        expect(newEntry).toBeDefined();
        expect(newEntry.verb).toBe("join");
        expect(newEntry.isActive).toBe(true);
        expect(newEntry.role).toBe("member");
        const meta = newEntry.metadata as Record<string, unknown>;
        expect(meta.grantType).toBe("password_challenge");
        expect(meta.renewedFrom).toBeDefined();
      }));
  });

  // =========================================================================
  // checkGroupMembership
  // =========================================================================

  describe("checkGroupMembership", () => {
    it("returns isMember false when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await checkGroupMembership(
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.isMember).toBe(false);
      }));

    it("returns isMember false for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await checkGroupMembership(INVALID_UUID);

        expect(result.isMember).toBe(false);
      }));

    it("returns isMember false when no active membership exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await checkGroupMembership(group.id);

        expect(result.isMember).toBe(false);
      }));

    it("returns full membership details when active membership exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        const membership = await createMembership(db, user.id, group.id, "member");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await checkGroupMembership(group.id);

        expect(result.isMember).toBe(true);
        expect(result.membershipId).toBe(membership.id);
        expect(result.role).toBe("member");
      }));
  });
});
