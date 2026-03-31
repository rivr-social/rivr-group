import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createMembership,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

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

vi.mock("@/lib/billing", () => ({
  hasEntitlement: vi.fn().mockResolvedValue(true),
  getActiveSubscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ai", () => ({
  embedResource: vi.fn().mockResolvedValue(undefined),
  scheduleEmbedding: vi.fn((fn: () => void) => fn()),
}));

vi.mock("@/lib/murmurations", () => ({
  syncMurmurationsProfilesForActor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/federation", () => ({
  getHostedNodeForOwner: vi.fn().mockResolvedValue(null),
  queueEntityExportEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/queries/agents", () => ({
  getAgent: vi.fn().mockResolvedValue({ name: "Test Agent", image: null }),
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { hasEntitlement } from "@/lib/billing";
import { createEventResource } from "../events";

// =============================================================================
// Constants
// =============================================================================

const MAX_EVENT_DESCRIPTION_LENGTH = 50000;

const VALID_EVENT_INPUT = {
  title: "Community Gathering",
  description: "A fun get-together for the community.",
  date: "2026-04-15",
  time: "14:00",
  location: "City Park",
  eventType: "in-person" as const,
};

// =============================================================================
// Tests
// =============================================================================

describe("event creation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createEventResource", () => {
    it("returns INVALID_INPUT when title is missing", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          title: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description is missing", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          description: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when date is missing", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          date: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when time is missing", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          time: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when location is missing", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          location: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("maximum length");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createEventResource(VALID_EVENT_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("creates an event resource when input is valid", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource(VALID_EVENT_INPUT);

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
        expect(result.message).toContain("Created");
      }));

    it("returns FORBIDDEN when posting as a group without membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          groupId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("allows event creation when user is a group member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db, {
          metadata: { creatorId: user.id },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          groupId: group.id,
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));

    it("returns SUBSCRIPTION_REQUIRED for paid tickets without host tier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(hasEntitlement).mockResolvedValueOnce(false);

        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          price: 25,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
        expect(result.error?.requiredTier).toBe("host");
      }));

    it("sets visibility to private when scoped to groups and not global", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource({
          ...VALID_EVENT_INPUT,
          isGlobal: false,
          scopedGroupIds: ["group-id-1"],
        });

        expect(result.success).toBe(true);
      }));

    it("sets visibility to public when isGlobal is true (default)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEventResource(VALID_EVENT_INPUT);

        expect(result.success).toBe(true);
      }));
  });
});
