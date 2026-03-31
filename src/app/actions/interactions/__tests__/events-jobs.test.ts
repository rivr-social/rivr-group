import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestEvent,
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
  setEventRsvp,
  applyToJob,
  fetchMyJobApplicationIds,
  fetchEventRsvpCount,
  fetchEventAttendees,
  cancelEventAction,
} from "../events-jobs";

// =============================================================================
// Tests
// =============================================================================

describe("events-jobs interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          type: "listing",
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
          type: "listing",
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
  // fetchMyJobApplicationIds
  // ---------------------------------------------------------------------------

  describe("fetchMyJobApplicationIds", () => {
    it("returns empty array when unauthenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await fetchMyJobApplicationIds();

        expect(result).toEqual([]);
      }));

    it("returns job IDs the user has applied to", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const employer = await createTestAgent(txDb);
        const job1 = await createTestResource(txDb, employer.id, {
          name: "Job 1",
          type: "listing",
        });
        const job2 = await createTestResource(txDb, employer.id, {
          name: "Job 2",
          type: "listing",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await applyToJob(job1.id);
        await applyToJob(job2.id);

        const result = await fetchMyJobApplicationIds();

        expect(result.length).toBe(2);
        expect(result).toContain(job1.id);
        expect(result).toContain(job2.id);
      }));

    it("excludes toggled-off applications", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const employer = await createTestAgent(txDb);
        const job = await createTestResource(txDb, employer.id, {
          name: "Job",
          type: "listing",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await applyToJob(job.id);
        await applyToJob(job.id); // toggle off

        const result = await fetchMyJobApplicationIds();

        expect(result).toEqual([]);
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchEventRsvpCount
  // ---------------------------------------------------------------------------

  describe("fetchEventRsvpCount", () => {
    it("returns 0 for an event with no RSVPs", () =>
      withTestTransaction(async (txDb) => {
        const event = await createTestEvent(txDb);

        const count = await fetchEventRsvpCount(event.id);

        expect(count).toBe(0);
      }));

    it("counts active RSVPs for an event", () =>
      withTestTransaction(async (txDb) => {
        const user1 = await createTestAgent(txDb);
        const user2 = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        await setEventRsvp(event.id, "going");

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user2.id));
        await setEventRsvp(event.id, "interested");

        const count = await fetchEventRsvpCount(event.id);

        expect(count).toBe(2);
      }));

    it("does not count removed RSVPs", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setEventRsvp(event.id, "going");
        await setEventRsvp(event.id, "none");

        const count = await fetchEventRsvpCount(event.id);

        expect(count).toBe(0);
      }));
  });

  // ---------------------------------------------------------------------------
  // fetchEventAttendees
  // ---------------------------------------------------------------------------

  describe("fetchEventAttendees", () => {
    it("returns empty array for event with no attendees", () =>
      withTestTransaction(async (txDb) => {
        const event = await createTestEvent(txDb);

        const attendees = await fetchEventAttendees(event.id);

        expect(attendees).toEqual([]);
      }));

    it("returns attendees with profile data", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb, { name: "Alice" });
        const event = await createTestEvent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await setEventRsvp(event.id, "going");

        const attendees = await fetchEventAttendees(event.id);

        expect(attendees.length).toBe(1);
        expect(attendees[0].id).toBe(user.id);
        expect(attendees[0].name).toBe("Alice");
        expect(attendees[0].status).toBe("going");
      }));
  });

  // ---------------------------------------------------------------------------
  // cancelEventAction
  // ---------------------------------------------------------------------------

  describe("cancelEventAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await cancelEventAction("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid event ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await cancelEventAction("not-a-uuid");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid event ID");
      }));

    it("returns error when event is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await cancelEventAction("11111111-1111-4111-8111-111111111111");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Event not found");
      }));

    it("returns error when user is not the event owner", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const other = await createTestAgent(txDb);
        const event = await createTestResource(txDb, owner.id, {
          name: "Community BBQ",
          type: "event",
          metadata: { entityType: "event" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));

        const result = await cancelEventAction(event.id);

        expect(result.success).toBe(false);
        expect(result.message).toContain("permission");
      }));

    it("cancels an event by updating metadata and creating ledger entry", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const event = await createTestResource(txDb, owner.id, {
          name: "Community BBQ",
          type: "event",
          metadata: { entityType: "event", status: "active" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const result = await cancelEventAction(event.id);

        expect(result.success).toBe(true);
        expect(result.message).toContain("cancelled successfully");

        // Verify metadata updated
        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, event.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.status).toBe("cancelled");

        // Verify ledger entry
        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, owner.id),
              eq(ledger.verb, "update"),
              eq(ledger.objectId, event.id),
            )
          );

        expect(entries.length).toBe(1);
        const ledgerMeta = entries[0].metadata as Record<string, unknown>;
        expect(ledgerMeta.action).toBe("cancel");
      }));
  });
});
