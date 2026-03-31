import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestLedgerEntry,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger } from "@/db/schema";

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
    WALLET: { limit: 100, windowMs: 60_000 },
  },
}));

// Import AFTER mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  requestFamilyWithdrawalAction,
  getFamilyContributionsAction,
} from "../family-treasury";

// =============================================================================
// Constants
// =============================================================================

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const MIN_WITHDRAWAL_CENTS = 100;
const MAX_WITHDRAWAL_CENTS = 1_000_000;
const MAX_PURPOSE_LENGTH = 500;

// =============================================================================
// Tests
// =============================================================================

describe("family treasury actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // requestFamilyWithdrawalAction
  // ===========================================================================

  describe("requestFamilyWithdrawalAction", () => {
    it("returns error when user is not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          5000,
          "Need supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("logged in");
      }));

    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValueOnce({ success: false, remaining: 0, resetMs: 60000 });

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          5000,
          "Supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Rate limit");
      }));

    it("returns error for invalid family UUID", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          "not-a-uuid",
          5000,
          "Supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid family ID");
      }));

    it("returns error for non-positive amount", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          0,
          "Supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive integer");
      }));

    it("returns error when amount is below minimum", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          50,
          "Supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Minimum withdrawal");
      }));

    it("returns error when amount exceeds maximum", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          MAX_WITHDRAWAL_CENTS + 1,
          "Supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Maximum withdrawal");
      }));

    it("returns error when purpose is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          5000,
          "   ",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("purpose is required");
      }));

    it("returns error when purpose exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          VALID_UUID,
          5000,
          "x".repeat(MAX_PURPOSE_LENGTH + 1),
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain(`${MAX_PURPOSE_LENGTH} characters`);
      }));

    it("returns error when user is not a family member", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const family = await createTestGroup(db, { type: "family" } as Record<string, unknown>);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          family.id,
          5000,
          "Need supplies",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("member");
      }));

    it("creates a withdrawal request ledger entry on success", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const family = await createTestGroup(db);

        // Create membership
        await createTestLedgerEntry(db, user.id, {
          verb: "belong",
          objectId: family.id,
          objectType: "agent",
          isActive: true,
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestFamilyWithdrawalAction(
          family.id,
          5000,
          "Need garden supplies",
        );

        expect(result.success).toBe(true);

        // Verify ledger entry was created
        const entries = await db
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.verb, "request"),
              eq(ledger.subjectId, user.id),
              eq(ledger.objectId, family.id),
            ),
          );

        expect(entries).toHaveLength(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("family-withdrawal");
        expect(meta.amountCents).toBe(5000);
        expect(meta.purpose).toBe("Need garden supplies");
        expect(meta.withdrawalStatus).toBe("pending");
      }));
  });

  // ===========================================================================
  // getFamilyContributionsAction
  // ===========================================================================

  describe("getFamilyContributionsAction", () => {
    it("returns error for invalid family UUID", () =>
      withTestTransaction(async () => {
        const result = await getFamilyContributionsAction("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid family ID");
        expect(result.contributions).toEqual({});
      }));

    it("returns empty contributions when no transfers exist", () =>
      withTestTransaction(async (db) => {
        const family = await createTestGroup(db);

        const result = await getFamilyContributionsAction(family.id);

        expect(result.success).toBe(true);
        expect(result.contributions).toEqual({});
      }));

    it("aggregates contributions by member from ledger entries", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const family = await createTestGroup(db);

        // Create transfer ledger entries
        await createTestLedgerEntry(db, user.id, {
          verb: "transfer",
          objectId: family.id,
          objectType: "agent",
          isActive: true,
          metadata: { amountCents: 3000 },
        });

        await createTestLedgerEntry(db, user.id, {
          verb: "fund",
          objectId: family.id,
          objectType: "agent",
          isActive: true,
          metadata: { amountCents: 2000 },
        });

        const result = await getFamilyContributionsAction(family.id);

        expect(result.success).toBe(true);
        expect(result.contributions[user.id]).toBe(5000);
      }));
  });
});
