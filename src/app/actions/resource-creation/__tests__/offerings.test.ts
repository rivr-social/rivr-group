import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
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
import { rateLimit } from "@/lib/rate-limit";
import { hasEntitlement } from "@/lib/billing";
import { createOfferingResource, createMarketplaceListingResource } from "../offerings";

// =============================================================================
// Constants
// =============================================================================

const MAX_OFFERING_DESCRIPTION_LENGTH = 50000;

const VALID_OFFERING_INPUT = {
  title: "Gardening Service",
  description: "Professional gardening assistance.",
  offeringType: "service",
  targetAgentTypes: ["person"],
};

const VALID_LISTING_INPUT = {
  listingType: "product" as const,
  title: "Fresh Tomatoes",
  description: "Locally grown organic tomatoes.",
  price: 5.99,
  category: "food",
  location: "Community Garden",
  tags: ["organic"],
  chapterTags: ["locale-123"],
  images: [],
};

// =============================================================================
// Tests
// =============================================================================

describe("offering creation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // createOfferingResource
  // ===========================================================================

  describe("createOfferingResource", () => {
    it("returns INVALID_INPUT when title is missing", () =>
      withTestTransaction(async () => {
        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          title: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          description: "x".repeat(MAX_OFFERING_DESCRIPTION_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("maximum length");
      }));

    it("returns INVALID_INPUT when no items and no offeringType", () =>
      withTestTransaction(async () => {
        const result = await createOfferingResource({
          title: "Test",
          description: "Test",
          targetAgentTypes: ["person"],
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("items or an offering type");
      }));

    it("returns INVALID_INPUT when quantityAvailable is not positive integer", () =>
      withTestTransaction(async () => {
        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          quantityAvailable: -5,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.message).toContain("positive whole number");
      }));

    it("returns INVALID_INPUT when quantityAvailable is not integer", () =>
      withTestTransaction(async () => {
        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          quantityAvailable: 3.5,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createOfferingResource(VALID_OFFERING_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns RATE_LIMITED when rate limit is exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await createOfferingResource(VALID_OFFERING_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("RATE_LIMITED");
      }));

    it("creates an offering when input is valid (standalone)", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createOfferingResource(VALID_OFFERING_INPUT);

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
        expect(result.message).toContain("Offering created");
      }));

    it("returns FORBIDDEN when creating for a group without membership", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const group = await createTestGroup(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          ownerId: group.id,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("FORBIDDEN");
      }));

    it("returns SUBSCRIPTION_REQUIRED for paid offerings without seller tier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(hasEntitlement).mockResolvedValueOnce(false);

        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          basePrice: 1000,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
        expect(result.error?.requiredTier).toBe("seller");
      }));

    it("sets visibility to private when scoped to groups", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          scopedGroupIds: ["group-id-1"],
        });

        expect(result.success).toBe(true);
      }));

    it("sets visibility to locale when scoped to locales only", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createOfferingResource({
          ...VALID_OFFERING_INPUT,
          scopedLocaleIds: ["locale-1"],
        });

        expect(result.success).toBe(true);
      }));
  });

  // ===========================================================================
  // createMarketplaceListingResource
  // ===========================================================================

  describe("createMarketplaceListingResource", () => {
    it("returns INVALID_INPUT when title is missing", () =>
      withTestTransaction(async () => {
        const result = await createMarketplaceListingResource({
          ...VALID_LISTING_INPUT,
          title: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description is missing", () =>
      withTestTransaction(async () => {
        const result = await createMarketplaceListingResource({
          ...VALID_LISTING_INPUT,
          description: "",
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when price is negative", () =>
      withTestTransaction(async () => {
        const result = await createMarketplaceListingResource({
          ...VALID_LISTING_INPUT,
          price: -1,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns INVALID_INPUT when description exceeds max length", () =>
      withTestTransaction(async () => {
        const result = await createMarketplaceListingResource({
          ...VALID_LISTING_INPUT,
          description: "x".repeat(MAX_OFFERING_DESCRIPTION_LENGTH + 1),
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
      }));

    it("returns UNAUTHENTICATED when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createMarketplaceListingResource(VALID_LISTING_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("UNAUTHENTICATED");
      }));

    it("returns SUBSCRIPTION_REQUIRED for paid listings without seller tier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(hasEntitlement).mockResolvedValueOnce(false);

        const result = await createMarketplaceListingResource(VALID_LISTING_INPUT);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("SUBSCRIPTION_REQUIRED");
        expect(result.error?.requiredTier).toBe("seller");
      }));

    it("creates a listing when input is valid and user has seller tier", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMarketplaceListingResource(VALID_LISTING_INPUT);

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeDefined();
      }));

    it("allows free listing without seller subscription", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMarketplaceListingResource({
          ...VALID_LISTING_INPUT,
          price: 0,
        });

        expect(result.success).toBe(true);
      }));
  });
});
