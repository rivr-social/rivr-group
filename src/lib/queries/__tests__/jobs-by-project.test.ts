/**
 * DB tests for the owner-agnostic project→jobs queries
 * (`@/lib/queries/resources`): `getJobsByProjectId` gathers a project's jobs by
 * `metadata.projectId` regardless of which subtree agent OWNS them (the #7 bug:
 * scoping to the parent group dropped every subgroup-owned job), and
 * `getTasksByJobIds` gathers child tasks by `metadata.jobId` across owners.
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

import { getJobsByProjectId, getTasksByJobIds } from "@/lib/queries/resources";

describe("getJobsByProjectId", () => {
  it("gathers jobs linked by projectId regardless of owning subtree agent", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PB Group" });
      const subgroup = await createTestAgent(db, { name: "PB Circle", type: "organization" });
      const project = await createTestResource(db, subgroup.id, {
        name: "PB Project",
        type: "project",
        metadata: {},
      });

      const groupJob = await createTestResource(db, group.id, {
        name: "Group-owned job",
        type: "job",
        metadata: { projectId: project.id },
      });
      const subgroupJob = await createTestResource(db, subgroup.id, {
        name: "Subgroup-owned job",
        type: "job",
        metadata: { projectId: project.id },
      });
      // A job linked to a DIFFERENT project must not leak in.
      await createTestResource(db, subgroup.id, {
        name: "Other project job",
        type: "job",
        metadata: { projectId: "00000000-0000-4000-8000-000000000000" },
      });

      const jobs = await getJobsByProjectId(project.id);
      const ids = jobs.map((j) => j.id);
      expect(ids).toContain(groupJob.id);
      expect(ids).toContain(subgroupJob.id); // the subtree job the old scan dropped
      expect(jobs).toHaveLength(2);
    }));
});

describe("getTasksByJobIds", () => {
  it("gathers child tasks by jobId across owners; empty input → []", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db, { name: "PB Group 2" });
      const subgroup = await createTestAgent(db, { name: "PB Circle 2", type: "organization" });
      const job = await createTestResource(db, group.id, { name: "Job", type: "job", metadata: {} });
      const t1 = await createTestResource(db, group.id, {
        name: "Group task",
        type: "task",
        metadata: { jobId: job.id, points: 5 },
      });
      const t2 = await createTestResource(db, subgroup.id, {
        name: "Subgroup task",
        type: "task",
        metadata: { jobId: job.id, points: 7 },
      });

      expect(await getTasksByJobIds([])).toEqual([]);
      const tasks = await getTasksByJobIds([job.id]);
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
    }));
});
