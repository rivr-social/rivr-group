import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createMembership,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents, ledger } from "@/db/schema";

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

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 500, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/ai", () => ({
  embedAgent: vi.fn().mockResolvedValue(undefined),
  embedResource: vi.fn().mockResolvedValue(undefined),
  scheduleEmbedding: vi.fn((fn: () => void) => fn()),
}));

vi.mock("@/lib/matrix-groups", () => ({
  createGroupMatrixRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/murmurations", () => ({
  syncMurmurationsProfilesForActor: vi.fn().mockResolvedValue(undefined),
}));

// createGroupResource imports `updateFacade`/`emitDomainEvent`/`EVENT_TYPES`
// from the bare "@/lib/federation" barrel, so keep those REAL (owner-routing is
// exercised against the test DB) and only stub the fire-and-forget node/export
// helpers.
vi.mock("@/lib/federation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/federation")>();
  return {
    ...actual,
    ensureLocalNode: vi.fn().mockResolvedValue({ id: "local-node-id" }),
    queueEntityExportEvents: vi.fn().mockResolvedValue(undefined),
  };
});

// Organization-type group creation is gated by the `create_org_group`
// capability. Mock @/lib/entitlements-server so `hasCapability` is controllable
// while `isOrganizationGroupType` (the free/gated group classifier, still in the
// pure @/lib/entitlements) stays REAL — community/family/ring must remain free.
vi.mock("@/lib/entitlements-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements-server")>();
  return {
    ...actual,
    hasCapability: vi.fn().mockResolvedValue(false),
  };
});

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { hasCapability } from "@/lib/entitlements-server";
import { createGroupResource } from "../groups";

// =============================================================================
// Constants
// =============================================================================

const MAX_GROUP_DESCRIPTION_LENGTH = 50000;

const VALID_GROUP_INPUT = {
  name: "Test Community",
  description: "A community for testing.",
  groupType: "community",
  chapter: "locale-123",
};

// =============================================================================
// Tests
// =============================================================================

describe("group creation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createGroupResource", () => {
    it("returns INVALID_INPUT when name is missing", () =>
      withTestTransaction(async () => {
        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          name: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description is missing", () =>
      withTestTransaction(async () => {
        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          description: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when groupType is missing", () =>
      withTestTransaction(async () => {
        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when chapter is missing", () =>
      withTestTransaction(async () => {
        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          chapter: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          description: "x".repeat(MAX_GROUP_DESCRIPTION_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("maximum length");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createGroupResource(VALID_GROUP_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns RATE_LIMITED when rate limit is exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await createGroupResource(VALID_GROUP_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("RATE_LIMITED");
      }));

    it("creates a group agent with organization type", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource(VALID_GROUP_INPUT);

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        // Verify the agent was created as type "organization"
        const [group] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));

        expect(group).toBeDefined();
        expect(group.type).toBe("organization");
        expect(group.name).toBe("Test Community");
      }));

    it("creates a membership ledger entry for the creator", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource(VALID_GROUP_INPUT);

        expect(result.success).toBe(true);

        // Verify the create ledger entry
        const entries = await db
          .select()
          .from(ledger)
          .where(eq(ledger.subjectId, user.id));

        const createEntry = entries.find((e) => e.verb === "create");
        expect(createEntry).toBeDefined();
        expect(createEntry?.objectId).toBe(result.resourceId);
      }));

    it("returns FORBIDDEN when creating subgroup without parent access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const parentGroup = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          parentGroupId: parentGroup.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("allows subgroup creation when user has parent group access", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const parentGroup = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          parentGroupId: parentGroup.id,
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));

    it("sets visibility to private when join settings visibility is hidden", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          joinSettings: {
            joinType: "open",
            visibility: "hidden",
            questions: [],
            approvalRequired: false,
            passwordRequired: false,
          },
        });

        expect(result.success).toBe(true);

        const [group] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));

        expect(group.visibility).toBe("private");
      }));

    it("trims name and description", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          name: "  Padded Name  ",
          description: "  Padded Description  ",
        });

        expect(result.success).toBe(true);

        const [group] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));

        expect(group.name).toBe("Padded Name");
        expect(group.description).toBe("Padded Description");
      }));

    // -------------------------------------------------------------------------
    // Capability gate: organization creation is paid; community/family/ring free
    // -------------------------------------------------------------------------

    it("creates a community group without any subscription (free)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "community",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
        // Free group types never consult the capability gate.
        expect(hasCapability).not.toHaveBeenCalled();
      }));

    it("creates a family group without any subscription (free)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "family",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
        expect(hasCapability).not.toHaveBeenCalled();
      }));

    it("creates a ring group without any subscription (free)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "ring",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
        expect(hasCapability).not.toHaveBeenCalled();
      }));

    it("requires the create_org_group capability to create an organization", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        // Default mock: no create_org_group capability.
        vi.mocked(hasCapability).mockResolvedValue(false);

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "organization",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
        expect(result.error?.requiredTier).toBe("organizer");
        expect(hasCapability).toHaveBeenCalledWith(user.id, "create_org_group");
      }));

    it("creates an organization when the user holds create_org_group", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(hasCapability).mockResolvedValue(true);

        const result = await createGroupResource({
          ...VALID_GROUP_INPUT,
          groupType: "organization",
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();

        const [group] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.resourceId!));
        expect(group.type).toBe("organization");
        const meta = group.metadata as Record<string, unknown>;
        expect(meta.groupType).toBe("organization");
      }));
  });
});
