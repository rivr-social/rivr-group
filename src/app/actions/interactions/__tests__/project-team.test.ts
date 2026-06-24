import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
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

// hasGroupWriteAccess is dynamically imported inside the action; default-deny
// so that only the job owner can record a contribution unless overridden.
vi.mock("@/app/actions/create-resources", () => ({
  hasGroupWriteAccess: vi.fn().mockResolvedValue(false),
}));

// emitDomainEvent fires a fire-and-forget insert into federation_events using
// the (test-invalid) instance node id; left unmocked its async failure poisons
// the shared test transaction. The action only needs it to no-op here.
vi.mock("@/lib/federation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/federation")>(
    "@/lib/federation",
  );
  return {
    ...actual,
    emitDomainEvent: vi.fn().mockResolvedValue({ id: "test-event" }),
  };
});

vi.mock("@/lib/federation/remote-write", () => ({
  federatedWrite: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { hasGroupWriteAccess } from "@/app/actions/create-resources";
import {
  recordJobContributionAction,
  getRecordedContributions,
} from "../project-team";

const JOB_CONTRIBUTION_INTERACTION = "job-contribution";

// =============================================================================
// Tests
// =============================================================================

describe("project-team contribution actions (J2 corrected model)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // recordJobContributionAction
  // ---------------------------------------------------------------------------

  describe("recordJobContributionAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await recordJobContributionAction({
          jobId: "11111111-1111-4111-8111-111111111111",
          contributorId: "22222222-2222-4222-8222-222222222222",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("rejects invalid job or contributor ids", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordJobContributionAction({
          jobId: "not-a-uuid",
          contributorId: "also-bad",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid");
      }));

    it("returns not found when the job does not exist", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await recordJobContributionAction({
          jobId: "33333333-3333-4333-8333-333333333333",
          contributorId: user.id,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Job not found");
      }));

    it("records a Stake contribution when the job owner completes a job", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const contributor = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const job = await createTestResource(txDb, group.id, {
          name: "Build the deck",
          type: "job",
          metadata: { entityType: "job", projectId: group.id },
        });
        // Job owner is the group; owner agent acts as the group owner.
        // Authenticate as the job owner (the resource owner) by aligning ids:
        // we authenticate the group itself acting through its owner agent.
        vi.mocked(auth).mockResolvedValue(mockAuthSession(group.id));

        const result = await recordJobContributionAction({
          jobId: job.id,
          contributorId: contributor.id,
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain("Contribution recorded");

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, contributor.id),
              eq(ledger.verb, "complete"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = ${JOB_CONTRIBUTION_INTERACTION}`,
              sql`${ledger.metadata}->>'jobId' = ${job.id}`,
            ),
          );

        expect(entries.length).toBe(1);
        expect(entries[0].objectId).toBe(job.id);
        expect((entries[0].metadata as Record<string, unknown>).source).toBe(
          "job-completion",
        );
        // Ensure NO badge award metadata is written (corrected model).
        expect(
          (entries[0].metadata as Record<string, unknown>).awardBadgeId,
        ).toBeUndefined();

        void owner;
      }));

    it("allows a group admin (write access) to record a contribution", () =>
      withTestTransaction(async (txDb) => {
        const admin = await createTestAgent(txDb);
        const contributor = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const job = await createTestResource(txDb, group.id, {
          name: "Paint the fence",
          type: "job",
          metadata: { entityType: "job" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
        // Admin is NOT the job owner, but has group write access.
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(true);

        const result = await recordJobContributionAction({
          jobId: job.id,
          contributorId: contributor.id,
        });

        expect(result.success).toBe(true);
        expect(hasGroupWriteAccess).toHaveBeenCalledWith(admin.id, group.id);
      }));

    it("denies recording when the caller is neither owner nor admin", () =>
      withTestTransaction(async (txDb) => {
        const stranger = await createTestAgent(txDb);
        const contributor = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const job = await createTestResource(txDb, group.id, {
          name: "Restricted job",
          type: "job",
          metadata: { entityType: "job" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(stranger.id));
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(false);

        const result = await recordJobContributionAction({
          jobId: job.id,
          contributorId: contributor.id,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Only the job owner or a group admin");
      }));

    it("is idempotent — recording the same contribution twice writes a single edge", () =>
      withTestTransaction(async (txDb) => {
        const contributor = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const job = await createTestResource(txDb, group.id, {
          name: "One-time contribution",
          type: "job",
          metadata: { entityType: "job" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(group.id));

        const first = await recordJobContributionAction({
          jobId: job.id,
          contributorId: contributor.id,
        });
        const second = await recordJobContributionAction({
          jobId: job.id,
          contributorId: contributor.id,
        });

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        expect(second.message).toContain("already recorded");

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, contributor.id),
              eq(ledger.verb, "complete"),
              sql`${ledger.metadata}->>'interactionType' = ${JOB_CONTRIBUTION_INTERACTION}`,
              sql`${ledger.metadata}->>'jobId' = ${job.id}`,
            ),
          );

        expect(entries.length).toBe(1);
      }));
  });

  // ---------------------------------------------------------------------------
  // getRecordedContributions
  // ---------------------------------------------------------------------------

  describe("getRecordedContributions", () => {
    it("returns an empty list for an invalid group id", async () => {
      const rows = await getRecordedContributions({ groupId: "not-a-uuid" });
      expect(rows).toEqual([]);
    });

    it("surfaces recorded contributors with per-contributor job counts", () =>
      withTestTransaction(async (txDb) => {
        const contributorA = await createTestAgent(txDb);
        const contributorB = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const job1 = await createTestResource(txDb, group.id, {
          name: "Job 1",
          type: "job",
          metadata: { entityType: "job" },
        });
        const job2 = await createTestResource(txDb, group.id, {
          name: "Job 2",
          type: "job",
          metadata: { entityType: "job" },
        });
        const job3 = await createTestResource(txDb, group.id, {
          name: "Job 3",
          type: "job",
          metadata: { entityType: "job" },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(group.id));

        // contributorA completes two jobs, contributorB completes one.
        await recordJobContributionAction({
          jobId: job1.id,
          contributorId: contributorA.id,
        });
        await recordJobContributionAction({
          jobId: job2.id,
          contributorId: contributorA.id,
        });
        await recordJobContributionAction({
          jobId: job3.id,
          contributorId: contributorB.id,
        });

        const rows = await getRecordedContributions({ groupId: group.id });

        expect(rows.length).toBe(2);
        const byId = new Map(rows.map((r) => [r.contributorId, r.jobCount]));
        expect(byId.get(contributorA.id)).toBe(2);
        expect(byId.get(contributorB.id)).toBe(1);
        // Ordered by job count descending: A (2) before B (1).
        expect(rows[0].contributorId).toBe(contributorA.id);
      }));

    it("scopes contributions to a specific project when projectId is provided", () =>
      withTestTransaction(async (txDb) => {
        const contributor = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const projectA = await createTestResource(txDb, group.id, {
          name: "Project A",
          type: "project",
        });
        const projectB = await createTestResource(txDb, group.id, {
          name: "Project B",
          type: "project",
        });
        const jobA = await createTestResource(txDb, group.id, {
          name: "Job in A",
          type: "job",
          metadata: { entityType: "job", projectId: projectA.id },
        });
        const jobB = await createTestResource(txDb, group.id, {
          name: "Job in B",
          type: "job",
          metadata: { entityType: "job", projectId: projectB.id },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(group.id));

        await recordJobContributionAction({
          jobId: jobA.id,
          contributorId: contributor.id,
        });
        await recordJobContributionAction({
          jobId: jobB.id,
          contributorId: contributor.id,
        });

        const rowsA = await getRecordedContributions({
          groupId: group.id,
          projectId: projectA.id,
        });

        expect(rowsA.length).toBe(1);
        expect(rowsA[0].contributorId).toBe(contributor.id);
        expect(rowsA[0].jobCount).toBe(1);
      }));
  });
});
