import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestEvent,
  createTestPost,
  createTestListing,
  createTestResource,
} from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { ledger, agents } from "@/db/schema";

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

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "test-msg-id" }),
}));

vi.mock("@/lib/email-templates", () => ({
  verificationEmail: vi.fn(() => ({ subject: "Verify", html: "<p>verify</p>", text: "verify" })),
  systemNotificationEmail: vi.fn(() => ({ subject: "Notice", html: "<p>notice</p>", text: "notice" })),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { db } from "@/db";
import {
  toggleLikeOnTarget,
  toggleFollowAgent,
  toggleJoinGroup,
  setEventRsvp,
  toggleSaveListing,
  applyToJob,
  createVoucherAction,
  claimVoucherAction,
  redeemVoucherAction,
  sendVoucherAction,
  updateMyProfile,
} from "../interactions";
import { resources } from "@/db/schema";

// =============================================================================
// Tests
// =============================================================================

describe("interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // toggleLikeOnTarget
  // ---------------------------------------------------------------------------

  describe("toggleLikeOnTarget", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleLikeOnTarget("any-id", "post");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a like ledger entry when none exists", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleLikeOnTarget(post.id, "post");

        expect(result).toEqual({
          success: true,
          message: "like added",
          active: true,
        });

        // Verify ledger entry exists
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "react"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(post.id);
        expect(entries[0].objectType).toBe("post");
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("like");
      }));

    it("toggles off an existing like (deactivates)", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const poster = await createTestAgent(txDb);
        const post = await createTestPost(txDb, poster.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Like, then unlike
        await toggleLikeOnTarget(post.id, "post");
        const result = await toggleLikeOnTarget(post.id, "post");

        expect(result).toEqual({
          success: true,
          message: "like removed",
          active: false,
        });

        // Verify no active like entries remain
        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "react"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleFollowAgent
  // ---------------------------------------------------------------------------

  describe("toggleFollowAgent", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleFollowAgent("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a follow/connect ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleFollowAgent(target.id);

        expect(result).toEqual({
          success: true,
          message: "connect added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "follow"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(target.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("connect");
      }));

    it("toggles off an existing follow", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const target = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleFollowAgent(target.id);
        const result = await toggleFollowAgent(target.id);

        expect(result).toEqual({
          success: true,
          message: "connect removed",
          active: false,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "follow"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleJoinGroup
  // ---------------------------------------------------------------------------

  describe("toggleJoinGroup", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleJoinGroup("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a membership ledger entry for a group", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleJoinGroup(group.id);

        expect(result).toEqual({
          success: true,
          message: "membership added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(group.id);
        expect(entries[0].objectType).toBe("group");
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("membership");
      }));

    it("toggles off an existing membership", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleJoinGroup(group.id);
        const result = await toggleJoinGroup(group.id);

        expect(result).toEqual({
          success: true,
          message: "membership removed",
          active: false,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true)
            )
          );

        expect(activeEntries.length).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // setEventRsvp
  // ---------------------------------------------------------------------------

  describe("setEventRsvp", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await setEventRsvp("any-id", "going");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates an RSVP going entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setEventRsvp(event.id, "going");

        expect(result).toEqual({
          success: true,
          message: "RSVP set to going",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'rsvp'`
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.status).toBe("going");
      }));

    it("creates an RSVP interested entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await setEventRsvp(event.id, "interested");

        expect(result).toEqual({
          success: true,
          message: "RSVP set to interested",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'rsvp'`
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.status).toBe("interested");
      }));

    it("removes RSVP with status 'none'", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Set going, then remove
        await setEventRsvp(event.id, "going");
        const result = await setEventRsvp(event.id, "none");

        expect(result).toEqual({
          success: true,
          message: "RSVP removed",
          active: false,
        });

        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'rsvp'`
            )
          );

        expect(activeEntries.length).toBe(0);
      }));

    it("replaces existing RSVP when changing status", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setEventRsvp(event.id, "going");
        const result = await setEventRsvp(event.id, "interested");

        expect(result).toEqual({
          success: true,
          message: "RSVP set to interested",
          active: true,
        });

        // Only one active RSVP should exist
        const activeEntries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'rsvp'`
            )
          );

        expect(activeEntries.length).toBe(1);
        const meta = activeEntries[0].metadata as Record<string, unknown>;
        expect(meta.status).toBe("interested");
      }));
  });

  // ---------------------------------------------------------------------------
  // toggleSaveListing
  // ---------------------------------------------------------------------------

  describe("toggleSaveListing", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await toggleSaveListing("any-id");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("creates a save ledger entry for a listing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const seller = await createTestAgent(txDb);
        const listing = await createTestListing(txDb, seller.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await toggleSaveListing(listing.id);

        expect(result).toEqual({
          success: true,
          message: "save added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "share"),
              eq(ledger.isActive, true)
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.interactionType).toBe("save");
      }));

    it("toggles off a saved listing", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const seller = await createTestAgent(txDb);
        const listing = await createTestListing(txDb, seller.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await toggleSaveListing(listing.id);
        const result = await toggleSaveListing(listing.id);

        expect(result).toEqual({
          success: true,
          message: "save removed",
          active: false,
        });
      }));
  });

  // ---------------------------------------------------------------------------
  // applyToJob
  // ---------------------------------------------------------------------------

  describe("applyToJob", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await applyToJob("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid job id", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await applyToJob("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid job id");
      }));

    it("creates a job-application ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const employer = await createTestAgent(txDb);
        const job = await createTestResource(txDb, employer.id, {
          name: "Test Job Posting",
          type: "listing" as const,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await applyToJob(job.id);

        expect(result).toEqual({
          success: true,
          message: "job-application added",
          active: true,
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'job-application'`
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(job.id);
      }));

    it("toggles off a job application", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const employer = await createTestAgent(txDb);
        const job = await createTestResource(txDb, employer.id, {
          name: "Test Job Posting",
          type: "listing" as const,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await applyToJob(job.id);
        const result = await applyToJob(job.id);

        expect(result).toEqual({
          success: true,
          message: "job-application removed",
          active: false,
        });
      }));
  });

  // ---------------------------------------------------------------------------
  // createVoucherAction / claimVoucherAction / redeemVoucherAction
  // ---------------------------------------------------------------------------

  describe("voucher pool actions", () => {
    it("creates a voucher resource scoped to a ring", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Childcare swap",
          description: "Two hours of childcare help.",
          category: "service",
          ringId: ring.id,
          estimatedValue: 40,
          maxClaims: 2,
        });

        expect(result.success).toBe(true);
        expect(result.resourceId).toBeTruthy();

        const [created] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, result.resourceId!));

        expect(created.type).toBe("voucher");
        expect(created.tags).toContain(ring.id);

        const meta = created.metadata as Record<string, unknown>;
        expect(meta.resourceKind).toBe("voucher");
        expect(meta.ringId).toBe(ring.id);
        expect(meta.status).toBe("available");
        expect(meta.maxClaims).toBe(2);
      }));

    it("rejects voucher creation for an invalid ring id", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createVoucherAction({
          title: "Garden help",
          description: "Weekend volunteer time.",
          category: "service",
          ringId: "not-a-uuid",
        });

        expect(result).toEqual({
          success: false,
          message: "Invalid ring ID.",
        });
      }));

    it("claims and redeems a voucher", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const claimant = await createTestAgent(txDb);
        const ring = await createTestGroup(txDb);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));
        const createResult = await createVoucherAction({
          title: "Tool lending",
          description: "Borrow my wheelbarrow for a day.",
          category: "resource",
          ringId: ring.id,
        });

        expect(createResult.success).toBe(true);
        const voucherId = createResult.resourceId!;

        vi.mocked(auth).mockResolvedValue(mockAuthSession(claimant.id));
        const claimResult = await claimVoucherAction(voucherId);
        expect(claimResult).toEqual({
          success: true,
          message: "Voucher claimed successfully.",
        });

        let [claimedVoucher] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, voucherId));

        let meta = claimedVoucher.metadata as Record<string, unknown>;
        expect(meta.status).toBe("claimed");
        expect(meta.claimedBy).toBe(claimant.id);
        expect(meta.currentClaims).toBe(1);

        const redeemResult = await redeemVoucherAction(voucherId);
        expect(redeemResult.success).toBe(true);
        expect(redeemResult.message).toContain("Voucher redeemed successfully.");

        [claimedVoucher] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, voucherId));

        meta = claimedVoucher.metadata as Record<string, unknown>;
        expect(meta.status).toBe("completed");
        expect(meta.redeemedBy).toBe(claimant.id);
      }));
  });

  // ---------------------------------------------------------------------------
  // sendVoucherAction
  // ---------------------------------------------------------------------------

  describe("sendVoucherAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await sendVoucherAction(
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid voucher id", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendVoucherAction(
          "not-a-uuid",
          "22222222-2222-4222-8222-222222222222"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("returns error for invalid recipient id", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await sendVoucherAction(
          "11111111-1111-4111-8111-111111111111",
          "not-a-uuid"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("creates a voucher-gift ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, sender.id, {
          name: "Test Voucher",
          type: "document" as const,
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendVoucherAction(
          voucher.id,
          recipient.id,
          "Enjoy this voucher!"
        );

        expect(result).toEqual({
          success: true,
          message: "Voucher sent.",
        });

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "gift"),
              sql`${ledger.metadata}->>'interactionType' = 'voucher-gift'`
            )
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(recipient.id);
        expect(entries[0].resourceId).toBe(voucher.id);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.message).toBe("Enjoy this voucher!");
        expect(meta.voucherId).toBe(voucher.id);
      }));

    it("sends voucher with empty message when none provided", () =>
      withTestTransaction(async (txDb) => {
        const sender = await createTestAgent(txDb);
        const recipient = await createTestAgent(txDb);
        const voucher = await createTestResource(txDb, sender.id, {
          name: "Another Voucher",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(sender.id));

        const result = await sendVoucherAction(voucher.id, recipient.id);

        expect(result.success).toBe(true);

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, sender.id),
              eq(ledger.verb, "gift")
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.message).toBe("");
      }));
  });

  // ---------------------------------------------------------------------------
  // updateMyProfile
  // ---------------------------------------------------------------------------

  describe("updateMyProfile", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateMyProfile({
          name: "New Name",
          bio: "New bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("updates agent name and description in database", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb, {
          name: "Old Name",
          description: "Old bio",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "Updated Name",
          bio: "Updated bio text",
          skills: ["cooking", "gardening"],
          location: "Portland, OR",
        });

        expect(result).toEqual({
          success: true,
          message: "Profile updated.",
        });

        // Verify DB was updated
        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        expect(updated.name).toBe("Updated Name");
        expect(updated.description).toBe("Updated bio text");
        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.skills).toEqual(["cooking", "gardening"]);
        expect(meta.location).toBe("Portland, OR");
      }));

    it("delegates to updateProfileAction and updates metadata", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "New Name",
          bio: "Some bio",
          skills: ["gardening"],
        });

        expect(result).toEqual({ success: true, message: "Profile updated." });

        // Verify the agent was updated in DB
        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        expect(updated.name).toBe("New Name");
        expect(updated.description).toBe("Some bio");
        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.skills).toEqual(["gardening"]);
      }));

    it("returns error when name is empty", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "   ",
          bio: "bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Name is required");
      }));

    it("returns error when name exceeds max length", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "a".repeat(101),
          bio: "bio",
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("100 characters");
      }));

    it("returns error when bio exceeds max length", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateMyProfile({
          name: "Name",
          bio: "x".repeat(501),
          skills: [],
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("500 characters");
      }));

    it("accepts many skills since validation is not enforced at this layer", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const manySkills = Array.from({ length: 26 }, (_, i) => `skill-${i}`);

        const result = await updateMyProfile({
          name: "Name",
          bio: "bio",
          skills: manySkills,
        });

        expect(result.success).toBe(true);
        expect(result.message).toBe("Profile updated.");
      }));

    it("trims and filters empty skills", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await updateMyProfile({
          name: "Name",
          bio: "bio",
          skills: ["  cooking  ", "", "  ", "gardening"],
        });

        const [updated] = await txDb
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.skills).toEqual(["cooking", "gardening"]);
      }));
  });
});
