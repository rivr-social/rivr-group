import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
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
  sendThanksTokenAction,
  sendThanksTokensAction,
  mintThanksTokensForVoucherRedemption,
} from "../thanks-tokens";
import type { TestDatabase } from "@/test/db";

// =============================================================================
// Helpers
// =============================================================================

async function createThanksToken(db: TestDatabase, ownerId: string) {
  return createTestResource(db, ownerId, {
    name: "Thanks Token",
    type: "thanks_token",
    metadata: {
      entityType: "thanks_token",
      creatorId: ownerId,
      currentOwnerId: ownerId,
      transferHistory: [],
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("thanks-tokens interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // sendThanksTokenAction
  // ---------------------------------------------------------------------------

  describe("sendThanksTokenAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await sendThanksTokenAction(
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid token or recipient ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokenAction("not-a-uuid", "also-bad");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("returns error when sending to yourself", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokenAction(
          "11111111-1111-4111-8111-111111111111",
          user.id
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("cannot send a thanks token to yourself");
      }));

    it("returns error when token is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokenAction(
          "11111111-1111-4111-8111-111111111111",
          recipient.id
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("not found");
      }));

    it("returns error when resource is not a thanks token", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const resource = await createTestResource(txDb, user.id, {
          name: "Not a token",
          type: "document",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokenAction(resource.id, recipient.id);

        expect(result.success).toBe(false);
        expect(result.message).toContain("not a thanks token");
      }));

    it("returns error when user does not own the token", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const thief = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const token = await createThanksToken(txDb, owner.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(thief.id));

        const result = await sendThanksTokenAction(token.id, recipient.id);

        expect(result.success).toBe(false);
        expect(result.message).toContain("only send thanks tokens you own");
      }));

    it("transfers token ownership and records ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const token = await createThanksToken(txDb, sender.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendThanksTokenAction(
          token.id,
          recipient.id,
          "Thank you for your help!"
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain("Thanks token sent");

        // Verify ownership transferred
        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, token.id));

        expect(updated.ownerId).toBe(recipient.id);
        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.currentOwnerId).toBe(recipient.id);
        expect(Array.isArray(meta.transferHistory)).toBe(true);
        const history = meta.transferHistory as Array<Record<string, unknown>>;
        expect(history.length).toBe(1);
        expect(history[0].from).toBe(sender.id);
        expect(history[0].to).toBe(recipient.id);

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "gift"),
              sql`${ledger.metadata}->>'interactionType' = 'thanks-token-transfer'`
            )
          );

        expect(entries.length).toBe(1);
        const ledgerMeta = entries[0].metadata as Record<string, unknown>;
        expect(ledgerMeta.message).toBe("Thank you for your help!");
        expect(ledgerMeta.thanksTokenId).toBe(token.id);
      }));

    it("creates a comment ledger entry when contextId is provided", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const token = await createThanksToken(txDb, sender.id);
        const post = await createTestResource(txDb, recipient.id, {
          name: "Post",
          type: "post",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        await sendThanksTokenAction(
          token.id,
          recipient.id,
          "Great post!",
          post.id
        );

        const comments = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "comment"),
              eq(ledger.objectId, post.id)
            )
          );

        expect(comments.length).toBe(1);
        const meta = comments[0].metadata as Record<string, unknown>;
        expect(meta.isGift).toBe(true);
        expect(meta.giftType).toBe("thanks");
      }));
  });

  // ---------------------------------------------------------------------------
  // sendThanksTokensAction (batch)
  // ---------------------------------------------------------------------------

  describe("sendThanksTokensAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await sendThanksTokensAction(
          "22222222-2222-4222-8222-222222222222",
          1
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid recipient ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokensAction("not-a-uuid", 1);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid recipient");
      }));

    it("returns error when sending to yourself", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokensAction(user.id, 1);

        expect(result.success).toBe(false);
        expect(result.message).toContain("cannot send thanks tokens to yourself");
      }));

    it("returns error for zero or negative count", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokensAction(recipient.id, 0);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Choose how many");
      }));

    it("returns error when user has insufficient tokens", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendThanksTokensAction(recipient.id, 5);

        expect(result.success).toBe(false);
        expect(result.message).toContain("only have 0");
      }));

    it("sends multiple tokens successfully", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);

        // Create 2 thanks tokens
        await createThanksToken(txDb, sender.id);
        await createThanksToken(txDb, sender.id);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendThanksTokensAction(
          recipient.id,
          2,
          "Double thanks!"
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain("Sent 2 thanks tokens");

        // Verify both tokens transferred
        const senderTokens = await txDb
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.ownerId, sender.id),
              eq(resources.type, "thanks_token")
            )
          );

        expect(senderTokens.length).toBe(0);

        const recipientTokens = await txDb
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.ownerId, recipient.id),
              eq(resources.type, "thanks_token")
            )
          );

        expect(recipientTokens.length).toBe(2);
      }));

    it("handles singular message for count of 1", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        await createThanksToken(txDb, sender.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendThanksTokensAction(recipient.id, 1);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Sent 1 thanks token.");
      }));
  });

  // ---------------------------------------------------------------------------
  // mintThanksTokensForVoucherRedemption
  // ---------------------------------------------------------------------------

  describe("mintThanksTokensForVoucherRedemption", () => {
    it("does nothing when count is 0", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const redeemer = await createTestAgent(txDb);

        await mintThanksTokensForVoucherRedemption(
          txDb as never,
          "voucher-id",
          owner.id,
          redeemer.id,
          0
        );

        const tokens = await txDb
          .select()
          .from(resources)
          .where(eq(resources.type, "thanks_token"));

        expect(tokens.length).toBe(0);
      }));

    it("mints the specified number of tokens for the voucher owner", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const redeemer = await createTestAgent(txDb);

        await mintThanksTokensForVoucherRedemption(
          txDb as never,
          "11111111-1111-4111-8111-111111111111",
          owner.id,
          redeemer.id,
          3
        );

        const tokens = await txDb
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.ownerId, owner.id),
              eq(resources.type, "thanks_token")
            )
          );

        expect(tokens.length).toBe(3);

        const meta = tokens[0].metadata as Record<string, unknown>;
        expect(meta.entityType).toBe("thanks_token");
        expect(meta.creatorId).toBe(owner.id);
        expect(meta.sourceVoucherId).toBe("11111111-1111-4111-8111-111111111111");
        expect(meta.mintedByClaimantId).toBe(redeemer.id);
        expect(Array.isArray(meta.transferHistory)).toBe(true);
        const history = meta.transferHistory as Array<Record<string, unknown>>;
        expect(history[0].kind).toBe("mint");
      }));
  });
});
