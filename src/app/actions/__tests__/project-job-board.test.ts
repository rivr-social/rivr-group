/**
 * DB test for `fetchProjectJobBoard` (`@/app/actions/graph`): the group Jobs
 * board aggregates a project's jobs/points/completion by projectId linkage
 * ACROSS owning subtree agents (the #7 fix) and computes points/completion from
 * child `task` resources. Anonymous viewer path (public rows) so no auth
 * grants are needed.
 *
 * Run with `pnpm test:db`.
 */
import { describe, it, expect, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource } from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

// Anonymous viewer — the action falls back to the publicly-crawlable filter,
// which keeps public rows without per-item permission checks.
vi.mock("@/lib/auth/get-session", () => ({ getSession: vi.fn().mockResolvedValue(null) }));

import { fetchProjectJobBoard } from "@/app/actions/graph";

describe("fetchProjectJobBoard", () => {
  it("includes subgroup-owned jobs and computes points/completion from child tasks", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "JB Group" });
      const subgroup = await createTestAgent(db, { name: "JB Circle", type: "organization" });
      const project = await createTestResource(db, subgroup.id, {
        name: "Circle Leadership & Coordination",
        type: "project",
        visibility: "public",
        metadata: {},
      });

      // Subgroup-owned job — the row the old group-scoped scan dropped.
      const job = await createTestResource(db, subgroup.id, {
        name: "Coordinate the circle",
        type: "job",
        visibility: "public",
        metadata: { projectId: project.id, status: "open" },
      });
      // Two child tasks (10 + 20 points), one completed → 50% completion.
      await createTestResource(db, subgroup.id, {
        name: "Task A",
        type: "task",
        visibility: "public",
        metadata: { jobId: job.id, points: 10, completed: true, status: "completed" },
      });
      await createTestResource(db, subgroup.id, {
        name: "Task B",
        type: "task",
        visibility: "public",
        metadata: { jobId: job.id, points: 20 },
      });

      const board = await fetchProjectJobBoard(project.id);
      expect(board.jobs.map((j) => j.id)).toContain(job.id);
      expect(board.totalPoints).toBe(30);
      expect(board.totalTasks).toBe(2);
      expect(board.completedTasks).toBe(1);
      expect(board.completion).toBe(50);
    }));

  it("returns an empty board for an unknown/invalid project id", async () => {
    expect(await fetchProjectJobBoard("not-a-uuid")).toEqual({
      jobs: [],
      totalPoints: 0,
      totalTasks: 0,
      completedTasks: 0,
      completion: 0,
    });
  });
});
