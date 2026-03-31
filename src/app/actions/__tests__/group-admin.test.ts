/**
 * Tests for group-admin server actions.
 *
 * Uses real database via withTestTransaction — every test runs inside a
 * transaction that rolls back, giving perfect isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createMembership } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { eq } from "drizzle-orm";
import { agents } from "@/db/schema";
import { verify } from "@node-rs/bcrypt";
import { JoinType } from "@/lib/types";

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

import { auth } from "@/auth";
import {
  setGroupPassword,
  removeGroupPassword,
  fetchGroupAdminSettings,
  updateGroupJoinSettings,
  updateGroupMembershipPlans,
} from "../group-admin";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVALID_UUID = "not-a-valid-uuid";
const VALID_PASSWORD = "strongpassword123";
const SHORT_PASSWORD = "short";
const LONG_PASSWORD = "a".repeat(73);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group-admin actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // setGroupPassword
  // =========================================================================

  describe("setGroupPassword", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await setGroupPassword(
          "22222222-2222-4222-8222-222222222222",
          VALID_PASSWORD
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setGroupPassword(INVALID_UUID, VALID_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group identifier.");
      }));

    it("returns error when password is too short", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setGroupPassword(
          "22222222-2222-4222-8222-222222222222",
          SHORT_PASSWORD
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("at least 8 characters");
      }));

    it("returns error when password exceeds maximum length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setGroupPassword(
          "22222222-2222-4222-8222-222222222222",
          LONG_PASSWORD
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("at most 72 characters");
      }));

    it("returns error when user is not a group admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setGroupPassword(group.id, VALID_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Only group admins can manage the group password.");
      }));

    it("hashes password and updates group when admin sets password", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: admin.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await setGroupPassword(group.id, VALID_PASSWORD);

        expect(result.success).toBe(true);

        // Verify the password hash was stored in DB
        const [updatedGroup] = await db
          .select({ groupPasswordHash: agents.groupPasswordHash })
          .from(agents)
          .where(eq(agents.id, group.id));

        expect(updatedGroup.groupPasswordHash).toBeDefined();
        expect(updatedGroup.groupPasswordHash).not.toBeNull();

        // Verify the stored hash is a valid bcrypt hash by verifying the password
        const isValid = await verify(VALID_PASSWORD, updatedGroup.groupPasswordHash!);
        expect(isValid).toBe(true);
      }));

    it("allows admin with ledger entry to set password", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db);
        // Grant admin via ledger membership
        await createMembership(db, admin.id, group.id, "admin");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await setGroupPassword(group.id, VALID_PASSWORD);

        expect(result.success).toBe(true);
      }));
  });

  // =========================================================================
  // removeGroupPassword
  // =========================================================================

  describe("removeGroupPassword", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await removeGroupPassword(
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error for invalid UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await removeGroupPassword(INVALID_UUID);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid group identifier.");
      }));

    it("returns error when user is not a group admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await removeGroupPassword(group.id);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Only group admins can manage the group password.");
      }));

    it("sets groupPasswordHash to null on success", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          groupPasswordHash: "$2b$12$existingHash",
          metadata: { creatorId: admin.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await removeGroupPassword(group.id);

        expect(result.success).toBe(true);

        // Verify password hash was removed
        const [updatedGroup] = await db
          .select({ groupPasswordHash: agents.groupPasswordHash })
          .from(agents)
          .where(eq(agents.id, group.id));

        expect(updatedGroup.groupPasswordHash).toBeNull();
      }));
  });

  // =========================================================================
  // fetchGroupAdminSettings
  // =========================================================================

  describe("fetchGroupAdminSettings", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchGroupAdminSettings(
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error when user is not admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await fetchGroupAdminSettings(group.id);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Only group admins can view group settings.");
      }));

    it("returns group settings when admin (via creatorId)", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: {
            creatorId: admin.id,
            joinSettings: {
              joinType: JoinType.Public,
              questions: [],
              approvalRequired: false,
            },
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await fetchGroupAdminSettings(group.id);

        expect(result.success).toBe(true);
        expect(result.group).toBeDefined();
        expect(result.group!.id).toBe(group.id);
        expect(result.group!.name).toBe(group.name);
        expect(result.group!.joinSettings.joinType).toBe(JoinType.Public);
      }));

    it("returns group settings when admin (via ledger entry)", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db);
        await createMembership(db, admin.id, group.id, "admin");
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await fetchGroupAdminSettings(group.id);

        expect(result.success).toBe(true);
        expect(result.group).toBeDefined();
        expect(result.group!.id).toBe(group.id);
      }));
  });

  // =========================================================================
  // updateGroupJoinSettings
  // =========================================================================

  describe("updateGroupJoinSettings", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateGroupJoinSettings(
          "22222222-2222-4222-8222-222222222222",
          {
            joinType: JoinType.Public,
            questions: [],
            approvalRequired: false,
          }
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error when user is not admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateGroupJoinSettings(group.id, {
          joinType: JoinType.Public,
          questions: [],
          approvalRequired: false,
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe("Only group admins can edit group settings.");
      }));

    it("updates join settings in group metadata", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: admin.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const newSettings = {
          joinType: JoinType.ApprovalRequired,
          questions: [
            { id: "q-1", question: "Why do you want to join?", required: true, type: "text" as const },
          ],
          approvalRequired: true,
          applicationInstructions: "Please explain your interest.",
        };

        const result = await updateGroupJoinSettings(group.id, newSettings);

        expect(result.success).toBe(true);

        // Verify the metadata was updated in DB
        const [updatedGroup] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, group.id));

        const meta = updatedGroup.metadata as Record<string, unknown>;
        const joinSettings = meta.joinSettings as Record<string, unknown>;
        expect(joinSettings.joinType).toBe(JoinType.ApprovalRequired);
        expect(joinSettings.approvalRequired).toBe(true);
        expect(joinSettings.applicationInstructions).toBe("Please explain your interest.");
        expect(Array.isArray(joinSettings.questions)).toBe(true);
        const questions = joinSettings.questions as Array<Record<string, unknown>>;
        expect(questions.length).toBe(1);
        expect(questions[0].question).toBe("Why do you want to join?");
      }));

    it("preserves existing metadata fields when updating join settings", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: {
            creatorId: admin.id,
            groupType: "community",
            chapter: "Boulder",
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        await updateGroupJoinSettings(group.id, {
          joinType: JoinType.InviteOnly,
          questions: [],
          approvalRequired: false,
        });

        const [updatedGroup] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, group.id));

        const meta = updatedGroup.metadata as Record<string, unknown>;
        expect(meta.creatorId).toBe(admin.id);
        expect(meta.groupType).toBe("community");
        expect(meta.chapter).toBe("Boulder");
        const joinSettings = meta.joinSettings as Record<string, unknown>;
        expect(joinSettings.joinType).toBe(JoinType.InviteOnly);
      }));
  });

  // =========================================================================
  // updateGroupMembershipPlans
  // =========================================================================

  describe("updateGroupMembershipPlans", () => {
    it("returns error when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateGroupMembershipPlans(
          "22222222-2222-4222-8222-222222222222",
          [{ name: "Basic", amountMonthlyCents: 0 }]
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("Authentication required.");
      }));

    it("returns error when user is not admin", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateGroupMembershipPlans(group.id, [
          { name: "Basic", amountMonthlyCents: 0 },
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Only group admins can edit membership plans.");
      }));

    it("returns error when no valid plans are provided", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: admin.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const result = await updateGroupMembershipPlans(group.id, [
          { name: "" }, // empty name → gets filtered out
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain("at least one membership plan");
      }));

    it("updates membership plans in group metadata", () =>
      withTestTransaction(async (db) => {
        const admin = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: admin.id, chapter: "Boulder" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

        const plans = [
          { name: "Free", description: "Basic access", amountMonthlyCents: 0, perks: ["Access to public channels"] },
          { name: "Premium", description: "Full access", amountMonthlyCents: 999, perks: ["Priority support", "Private channels"] },
        ];

        const result = await updateGroupMembershipPlans(group.id, plans);

        expect(result.success).toBe(true);

        // Verify the metadata was updated
        const [updatedGroup] = await db
          .select({ metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, group.id));

        const meta = updatedGroup.metadata as Record<string, unknown>;
        expect(meta.chapter).toBe("Boulder"); // preserved
        expect(Array.isArray(meta.membershipPlans)).toBe(true);
        const storedPlans = meta.membershipPlans as Array<Record<string, unknown>>;
        expect(storedPlans.length).toBe(2);
        expect(storedPlans[0].name).toBe("Free");
        expect(storedPlans[1].name).toBe("Premium");
        expect(Array.isArray(meta.membershipTiers)).toBe(true);
        const tiers = meta.membershipTiers as string[];
        expect(tiers).toContain("Free");
        expect(tiers).toContain("Premium");
      }));
  });
});
