import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createMembership,
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

vi.mock("@/app/actions/create-resources", () => ({
  hasGroupWriteAccess: vi.fn().mockResolvedValue(false),
  createPostResource: vi.fn().mockResolvedValue({ success: true }),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { hasGroupWriteAccess } from "@/app/actions/create-resources";
import {
  claimTasksAction,
  updateTaskStatus,
} from "../tasks";

// =============================================================================
// Tests
// =============================================================================

describe("task interaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // claimTasksAction
  // ---------------------------------------------------------------------------

  describe("claimTasksAction", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await claimTasksAction(["11111111-1111-4111-8111-111111111111"]);

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error when no valid task IDs provided", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimTasksAction(["not-a-uuid", "also-bad"]);

        expect(result.success).toBe(false);
        expect(result.message).toContain("No valid task IDs");
      }));

    it("returns error for empty array", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimTasksAction([]);

        expect(result.success).toBe(false);
        expect(result.message).toContain("No valid task IDs");
      }));

    it("claims a single task successfully", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const task = await createTestResource(txDb, group.id, {
          name: "Fix the fence",
          type: "task",
          metadata: { entityType: "task", status: "not_started" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimTasksAction([task.id]);

        expect(result.success).toBe(true);
        expect(result.message).toContain("1 task claimed");

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, user.id),
              eq(ledger.verb, "join"),
              eq(ledger.isActive, true),
              sql`${ledger.metadata}->>'interactionType' = 'task-claim'`
            )
          );

        expect(entries.length).toBe(1);
      }));

    it("claims multiple tasks successfully", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const task1 = await createTestResource(txDb, group.id, {
          name: "Task 1",
          type: "task",
        });
        const task2 = await createTestResource(txDb, group.id, {
          name: "Task 2",
          type: "task",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimTasksAction([task1.id, task2.id]);

        expect(result.success).toBe(true);
        expect(result.message).toContain("2 tasks claimed");
      }));

    it("filters out invalid UUIDs from mixed input", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        const group = await createTestGroup(txDb);
        const task = await createTestResource(txDb, group.id, {
          name: "Task",
          type: "task",
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await claimTasksAction([task.id, "not-valid"]);

        expect(result.success).toBe(true);
        expect(result.message).toContain("1 task claimed");
      }));
  });

  // ---------------------------------------------------------------------------
  // updateTaskStatus
  // ---------------------------------------------------------------------------

  describe("updateTaskStatus", () => {
    it("returns unauthenticated message when no session", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await updateTaskStatus(
          "11111111-1111-4111-8111-111111111111",
          "in_progress"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("logged in");
      }));

    it("returns error for invalid task ID", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateTaskStatus("not-a-uuid", "in_progress");

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid task ID");
      }));

    it("returns error for invalid status value", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateTaskStatus(
          "11111111-1111-4111-8111-111111111111",
          "bogus" as never
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Invalid status");
      }));

    it("returns error when task is not found", () =>
      withTestTransaction(async (txDb) => {
        const user = await createTestAgent(txDb);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updateTaskStatus(
          "11111111-1111-4111-8111-111111111111",
          "in_progress"
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Task not found");
      }));

    it("returns error when user has no permission", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const other = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: { entityType: "task", status: "not_started" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(false);

        const result = await updateTaskStatus(task.id, "in_progress");

        expect(result.success).toBe(false);
        expect(result.message).toContain("permission");
      }));

    it("allows task owner to update status", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: { entityType: "task", status: "not_started" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const result = await updateTaskStatus(task.id, "in_progress");

        expect(result.success).toBe(true);
        expect(result.message).toContain("in_progress");

        // Verify metadata updated
        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, task.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.status).toBe("in_progress");
        expect(meta.completed).toBe(false);
      }));

    it("allows assignee to update status to awaiting_approval", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const assignee = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: {
            entityType: "task",
            status: "in_progress",
            assignedTo: assignee.id,
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(assignee.id));
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(false);

        const result = await updateTaskStatus(task.id, "awaiting_approval");

        expect(result.success).toBe(true);
        expect(result.message).toContain("awaiting_approval");
      }));

    it("prevents non-owner from completing a task", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const assignee = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: {
            entityType: "task",
            status: "awaiting_approval",
            assignedTo: assignee.id,
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(assignee.id));
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(false);

        const result = await updateTaskStatus(task.id, "completed");

        expect(result.success).toBe(false);
        expect(result.message).toContain("admin");
      }));

    it("allows owner to complete a task and records completed metadata", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: { entityType: "task", status: "awaiting_approval" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const result = await updateTaskStatus(task.id, "completed");

        expect(result.success).toBe(true);

        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, task.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.status).toBe("completed");
        expect(meta.completed).toBe(true);
        expect(meta.completedBy).toBe(owner.id);
        expect(meta.completedAt).toBeTruthy();
      }));

    it("records a ledger entry for status change", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: { entityType: "task", status: "not_started" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        await updateTaskStatus(task.id, "in_progress");

        const entries = await txDb
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.subjectId, owner.id),
              eq(ledger.verb, "update"),
              sql`${ledger.metadata}->>'interactionType' = 'task-status-update'`
            )
          );

        expect(entries.length).toBe(1);
        const meta = entries[0].metadata as Record<string, unknown>;
        expect(meta.previousStatus).toBe("not_started");
        expect(meta.newStatus).toBe("in_progress");
      }));

    it("allows group admin to complete a task", () =>
      withTestTransaction(async (txDb) => {
        const group = await createTestGroup(txDb);
        const admin = await createTestAgent(txDb);
        const task = await createTestResource(txDb, group.id, {
          name: "Fix fence",
          type: "task",
          metadata: { entityType: "task", status: "awaiting_approval" },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
        vi.mocked(hasGroupWriteAccess).mockResolvedValue(true);

        const result = await updateTaskStatus(task.id, "completed");

        expect(result.success).toBe(true);
        expect(result.message).toContain("completed");
      }));

    it("resets completed fields when rejecting a task", () =>
      withTestTransaction(async (txDb) => {
        const owner = await createTestAgent(txDb);
        const task = await createTestResource(txDb, owner.id, {
          name: "Fix fence",
          type: "task",
          metadata: {
            entityType: "task",
            status: "awaiting_approval",
            completed: true,
            completedAt: "2026-01-01",
          },
        });
        vi.mocked(auth).mockResolvedValue(mockAuthSession(owner.id));

        const result = await updateTaskStatus(task.id, "rejected");

        expect(result.success).toBe(true);

        const [updated] = await txDb
          .select()
          .from(resources)
          .where(eq(resources.id, task.id));

        const meta = updated.metadata as Record<string, unknown>;
        expect(meta.status).toBe("rejected");
        expect(meta.completed).toBe(false);
      }));
  });
});
