import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger, resources } from "@/db/schema";

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
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: {
    SOCIAL: { limit: 100, windowMs: 60000 },
    WALLET: { limit: 50, windowMs: 60000 },
    SETTINGS: { limit: 20, windowMs: 60000 },
  },
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  createMutualAssetAction,
  bookAssetAction,
} from "../assets";

// =============================================================================
// Tests
// =============================================================================

describe("asset interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createMutualAssetAction
  // ---------------------------------------------------------------------------

  describe("createMutualAssetAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createMutualAssetAction({
          name: "Lawnmower",
          description: "Gas-powered lawnmower",
          ringId: "11111111-1111-4111-8111-111111111111",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid ring ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMutualAssetAction({
          name: "Lawnmower",
          description: "Gas-powered lawnmower",
          ringId: "not-a-uuid",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid ring ID");
      }));

    it("returns error when name is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMutualAssetAction({
          name: "   ",
          description: "Some description",
          ringId: ring.id,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("name is required");
      }));

    it("returns error when description is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMutualAssetAction({
          name: "Lawnmower",
          description: "   ",
          ringId: ring.id,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("description is required");
      }));

    it("creates an asset resource and ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMutualAssetAction({
          name: "Lawnmower",
          description: "Gas-powered lawnmower for the neighborhood",
          category: "tool",
          ringId: ring.id,
          value: 200,
          location: "Shed behind community center",
          tags: ["garden", "tools"],
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain("Asset added");
        expect(result.resourceId).toBeTruthy();

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.type).toBe("asset");
        expect(created.name).toBe("Lawnmower");
        expect(created.ownerId).toBe(ring.id);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.entityType).toBe("mutual_asset");
        expect(meta.category).toBe("tool");
        expect(meta.status).toBe("available");
        expect(meta.assetValue).toBe(200);
        expect(meta.contributedBy).toBe(user.id);

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "create"),
              sql`${ledger.metadata}->>'interactionType' = 'asset-contribution'`
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].resourceId).toBe(result.resourceId);
      }));

    it("defaults category to 'other' for invalid categories", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createMutualAssetAction({
          name: "Mystery Item",
          description: "Something unusual",
          category: "invalid-category",
          ringId: ring.id,
        });

        expect(result.success).toBe(true);

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.category).toBe("other");
      }));
  });

  // ---------------------------------------------------------------------------
  // bookAssetAction
  // ---------------------------------------------------------------------------

  describe("bookAssetAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await bookAssetAction({
          assetId: "11111111-1111-4111-8111-111111111111",
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "Mowing my lawn",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid asset ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: "not-a-uuid",
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "Mowing",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid asset ID");
      }));

    it("returns error when dates are missing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: "11111111-1111-4111-8111-111111111111",
          startDate: "",
          endDate: "",
          purpose: "Mowing",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("dates are required");
      }));

    it("returns error when purpose is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: "11111111-1111-4111-8111-111111111111",
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "   ",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Purpose is required");
      }));

    it("returns error when end date is before start date", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: "11111111-1111-4111-8111-111111111111",
          startDate: "2026-04-05",
          endDate: "2026-04-01",
          purpose: "Mowing",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("End date must be after start date");
      }));

    it("returns error when asset is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: "11111111-1111-4111-8111-111111111111",
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "Mowing",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Asset not found");
      }));

    it("returns error when asset is not available", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        const asset = await createTestResource(txDb, ring.id, {
          name: "Reserved Tool",
          type: "asset",
          metadata: { entityType: "mutual_asset", status: "reserved" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: asset.id,
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "Mowing",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("reserved");
      }));

    it("books an available asset and updates status to reserved", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        const asset = await createTestResource(txDb, ring.id, {
          name: "Community Lawnmower",
          type: "asset",
          metadata: { entityType: "mutual_asset", status: "available" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await bookAssetAction({
          assetId: asset.id,
          startDate: "2026-04-01",
          endDate: "2026-04-02",
          purpose: "Mowing my front lawn",
          notes: "Will return by 5pm",
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain("Booking request submitted");

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "request"),
              sql`${ledger.metadata}->>'interactionType' = 'asset-booking'`
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.startDate).toBe("2026-04-01");
        expect(meta.endDate).toBe("2026-04-02");
        expect(meta.purpose).toBe("Mowing my front lawn");
        expect(meta.notes).toBe("Will return by 5pm");
        expect(meta.bookingStatus).toBe("pending");

        // Verify asset status updated
        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, asset.id));

        const updatedMeta = updated.metadata as Record<string, unknown>;
        expect(updatedMeta.status).toBe("reserved");
        expect(updatedMeta.currentUserId).toBe(user.id);
      }));
  });
});
