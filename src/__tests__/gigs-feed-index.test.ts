/**
 * Tests for the gigs feed task-job indexing logic.
 *
 * The GigsFeed component builds a Map<string, task[]> keyed by job ID
 * to replace an O(n*m) filter with O(n) indexing. These tests validate
 * the pure indexing logic extracted from the component's useMemo.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicate the pure helper functions from gigs-feed.tsx
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

// ---------------------------------------------------------------------------
// Minimal task shape matching SerializedResource from the component
// ---------------------------------------------------------------------------

interface MinimalTask {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
}

/**
 * Builds a Map<string, MinimalTask[]> keyed by job ID from an array of tasks.
 *
 * This is the exact logic from GigsFeed's `tasksByJobId` useMemo,
 * extracted as a pure function for testability.
 */
function buildTasksByJobId(tasks: MinimalTask[]): Map<string, MinimalTask[]> {
  const map = new Map<string, MinimalTask[]>();
  for (const task of tasks) {
    const tmeta = asRecord(task.metadata);
    const jobId = asString(tmeta.jobId || tmeta.jobDbId);
    if (jobId) {
      const existing = map.get(jobId) ?? [];
      existing.push(task);
      map.set(jobId, existing);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTasksByJobId — O(n) task-job indexing", () => {
  it("groups tasks with the same jobId together", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Task A", metadata: { jobId: "job-1" } },
      { id: "t2", name: "Task B", metadata: { jobId: "job-1" } },
      { id: "t3", name: "Task C", metadata: { jobId: "job-2" } },
    ];

    const index = buildTasksByJobId(tasks);

    expect(index.size).toBe(2);
    expect(index.get("job-1")).toHaveLength(2);
    expect(index.get("job-1")!.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(index.get("job-2")).toHaveLength(1);
    expect(index.get("job-2")![0].id).toBe("t3");
  });

  it("excludes tasks with no jobId or jobDbId", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Orphan", metadata: {} },
      { id: "t2", name: "No meta", metadata: { status: "open" } },
      { id: "t3", name: "Has job", metadata: { jobId: "job-1" } },
    ];

    const index = buildTasksByJobId(tasks);

    expect(index.size).toBe(1);
    expect(index.get("job-1")).toHaveLength(1);
  });

  it("returns empty map for empty input", () => {
    const index = buildTasksByJobId([]);
    expect(index.size).toBe(0);
  });

  it("uses jobDbId as fallback when jobId is absent", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Via jobDbId", metadata: { jobDbId: "job-x" } },
    ];

    const index = buildTasksByJobId(tasks);

    expect(index.size).toBe(1);
    expect(index.get("job-x")).toHaveLength(1);
    expect(index.get("job-x")![0].id).toBe("t1");
  });

  it("prefers jobId over jobDbId when both are present", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Both IDs", metadata: { jobId: "job-a", jobDbId: "job-b" } },
    ];

    const index = buildTasksByJobId(tasks);

    // jobId is used because `tmeta.jobId || tmeta.jobDbId` short-circuits on truthiness
    expect(index.size).toBe(1);
    expect(index.has("job-a")).toBe(true);
    expect(index.has("job-b")).toBe(false);
  });

  it("handles non-string metadata values gracefully", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Number ID", metadata: { jobId: 42 } },
      { id: "t2", name: "Null ID", metadata: { jobId: null } },
      { id: "t3", name: "Object ID", metadata: { jobId: { nested: true } } },
      { id: "t4", name: "Valid", metadata: { jobId: "job-valid" } },
    ];

    const index = buildTasksByJobId(tasks);

    // Only the string jobId should be indexed; non-strings fall through asString -> ""
    expect(index.size).toBe(1);
    expect(index.has("job-valid")).toBe(true);
  });

  it("handles null/undefined metadata without crashing", () => {
    const tasks: MinimalTask[] = [
      { id: "t1", name: "Null meta", metadata: null as unknown as Record<string, unknown> },
      { id: "t2", name: "Undefined meta", metadata: undefined as unknown as Record<string, unknown> },
    ];

    // asRecord handles non-object values by returning {}
    const index = buildTasksByJobId(tasks);
    expect(index.size).toBe(0);
  });

  it("handles large number of tasks linearly", () => {
    const TASK_COUNT = 10_000;
    const JOB_COUNT = 100;

    const tasks: MinimalTask[] = Array.from({ length: TASK_COUNT }, (_, i) => ({
      id: `t-${i}`,
      name: `Task ${i}`,
      metadata: { jobId: `job-${i % JOB_COUNT}` },
    }));

    const start = performance.now();
    const index = buildTasksByJobId(tasks);
    const elapsed = performance.now() - start;

    expect(index.size).toBe(JOB_COUNT);
    for (let j = 0; j < JOB_COUNT; j++) {
      expect(index.get(`job-${j}`)).toHaveLength(TASK_COUNT / JOB_COUNT);
    }

    // Should complete in well under 1 second for 10k tasks
    expect(elapsed).toBeLessThan(1000);
  });
});
