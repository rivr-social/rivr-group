/**
 * Tests for the group action tools' project/job/event list + update surface
 * (the tools an org's external agent uses to audit and repair schedules).
 *
 * Two concerns are covered:
 *   1. buildProjectListing — the pure read model that nests jobs under their
 *      project by metadata.projectId and surfaces the scheduling fields.
 *   2. The mutating tools (rivr.jobs.update / rivr.projects.update) — that they
 *      route every write through the canonical, permission-gated updateResource
 *      path (surfacing its FORBIDDEN denial rather than bypassing it) and that
 *      they validate ISO date input before touching the database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The group-action-tools module imports its create/update server actions and a
// query helper at load time. Stub them so the module loads without pulling in
// db/auth, and so we can assert how the tools call updateResource.
const mockUpdateResource = vi.fn();
const mockDeleteResource = vi.fn();
const mockCreateProjectResource = vi.fn();
const mockGetResourcesByOwnerAndType = vi.fn();

vi.mock("@/app/actions/resource-creation", () => ({
  createProjectResource: (...args: unknown[]) => mockCreateProjectResource(...args),
  createEventResource: vi.fn(),
  createOfferingResource: vi.fn(),
  createDocumentResourceAction: vi.fn(),
  createGroupResource: vi.fn(),
  updateGroupResource: vi.fn(),
  deleteGroupResource: vi.fn(),
  updateResource: (...args: unknown[]) => mockUpdateResource(...args),
  deleteResource: (...args: unknown[]) => mockDeleteResource(...args),
}));

vi.mock("@/app/actions/interactions/tasks", () => ({
  updateTaskStatus: vi.fn(),
  claimTasksAction: vi.fn(),
}));

vi.mock("@/app/actions/interactions/project-team", () => ({
  claimJobAction: vi.fn(),
  recordJobContributionAction: vi.fn(),
}));

vi.mock("@/app/actions/wallet/connect-backfill", () => ({
  backfillConnectAccountsAction: vi.fn(),
}));

vi.mock("@/app/actions/wallet/crypto-treasury", () => ({
  getCryptoTreasuryOverviewAction: vi.fn(),
  createBudgetProposalsAction: vi.fn(),
  createTransferProposalAction: vi.fn(),
}));

vi.mock("@/lib/queries/resources", () => ({
  getResourcesByOwnerAndType: (...args: unknown[]) => mockGetResourcesByOwnerAndType(...args),
  // The group-owned listing path added a subtree query; without it the module
  // mock is incomplete and the tool call throws.
  getResourcesByOwnerSubtreeAndType: (...args: unknown[]) =>
    mockGetResourcesByOwnerAndType(...args),
  // Task rollup for the job listing; no tasks in these fixtures.
  getTaskCountsByJob: vi.fn(async () => new Map<string, number>()),
}));

import {
  buildProjectListing,
  buildEventListing,
  GROUP_ACTION_TOOLS,
  type ListableResource,
} from "@/lib/federation/group-action-tools";

const GROUP_ID = "group-1";

function tool(name: string) {
  const found = GROUP_ACTION_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildProjectListing", () => {
  it("nests jobs under their project by metadata.projectId and surfaces scheduling fields", () => {
    const projects: ListableResource[] = [
      {
        id: "p1",
        name: "Spring Build",
        metadata: { status: "in_progress", timeframe: { start: "2026-03-01", end: "2026-05-31" } },
      },
      { id: "p2", name: "Autumn Harvest", metadata: { status: "planning" } },
    ];
    const jobs: ListableResource[] = [
      {
        id: "j1",
        name: "Frame the walls",
        metadata: {
          projectId: "p1",
          startDate: "2026-03-05",
          deadline: "2026-03-20",
          date: "2026-03-05",
          assignees: ["a1", "a2"],
          maxAssignees: 3,
        },
      },
      { id: "j2", name: "Paint", metadata: { projectId: "p1" } },
      { id: "j3", name: "Sow seeds", metadata: { projectId: "p2", deadline: "2026-09-15" } },
    ];

    const listing = buildProjectListing(projects, jobs);

    expect(listing).toHaveLength(2);

    const p1 = listing.find((p) => p.id === "p1")!;
    expect(p1.status).toBe("in_progress");
    expect(p1.timeframe).toEqual({ start: "2026-03-01", end: "2026-05-31" });
    expect(p1.jobs.map((j) => j.id)).toEqual(["j1", "j2"]);

    const j1 = p1.jobs.find((j) => j.id === "j1")!;
    expect(j1).toEqual({
      id: "j1",
      name: "Frame the walls",
      startDate: "2026-03-05",
      deadline: "2026-03-20",
      date: "2026-03-05",
      assignees: ["a1", "a2"],
      maxAssignees: 3,
      // Added when jobs gained cash compensation + task rollup.
      payKind: null,
      payAmountCents: null,
      hourlyRateCents: null,
      taskCount: 0,
    });

    // Job with only a projectId link still nests, with null/empty scheduling.
    const j2 = p1.jobs.find((j) => j.id === "j2")!;
    expect(j2).toEqual({
      id: "j2",
      name: "Paint",
      startDate: null,
      deadline: null,
      date: null,
      assignees: [],
      maxAssignees: null,
      payKind: null,
      payAmountCents: null,
      hourlyRateCents: null,
      taskCount: 0,
    });

    const p2 = listing.find((p) => p.id === "p2")!;
    expect(p2.timeframe).toEqual({ start: null, end: null });
    expect(p2.jobs.map((j) => j.id)).toEqual(["j3"]);
  });

  it("omits jobs that carry no projectId link", () => {
    const projects: ListableResource[] = [{ id: "p1", name: "P1", metadata: {} }];
    const jobs: ListableResource[] = [
      { id: "orphan", name: "Unlinked job", metadata: { deadline: "2026-01-01" } },
      { id: "j1", name: "Linked", metadata: { projectId: "p1" } },
    ];

    const listing = buildProjectListing(projects, jobs);

    expect(listing[0].jobs.map((j) => j.id)).toEqual(["j1"]);
  });

  it("tolerates null metadata on both projects and jobs", () => {
    const projects: ListableResource[] = [{ id: "p1", name: "P1", metadata: null }];
    const jobs: ListableResource[] = [{ id: "j1", name: "J1", metadata: null }];

    const listing = buildProjectListing(projects, jobs);

    expect(listing).toEqual([
      { id: "p1", name: "P1", status: null, timeframe: { start: null, end: null }, jobs: [] },
    ]);
  });
});

describe("rivr.projects.list tool", () => {
  it("nests group-owned jobs under group-owned projects", async () => {
    mockGetResourcesByOwnerAndType.mockImplementation(async (_owner: string, type: string) => {
      if (type === "project") return [{ id: "p1", name: "P1", metadata: { status: "active" } }];
      if (type === "job") return [{ id: "j1", name: "J1", metadata: { projectId: "p1" } }];
      return [];
    });

    const result = (await tool("rivr.projects.list").run({}, { groupId: GROUP_ID })) as {
      groupId: string;
      count: number;
      projects: Array<{ id: string; jobs: Array<{ id: string }> }>;
    };

    // Default project limit was raised 50 -> 200 (group-action-tools.ts).
    expect(mockGetResourcesByOwnerAndType).toHaveBeenCalledWith(GROUP_ID, "project", 200);
    expect(mockGetResourcesByOwnerAndType).toHaveBeenCalledWith(GROUP_ID, "job", 500);
    expect(result.count).toBe(1);
    expect(result.projects[0].jobs.map((j) => j.id)).toEqual(["j1"]);
  });
});

describe("rivr.jobs.update tool", () => {
  it("routes through the canonical updateResource with a merged metadata patch", async () => {
    mockUpdateResource.mockResolvedValue({ success: true, resourceId: "j1" });

    const result = await tool("rivr.jobs.update").run(
      { jobId: "j1", deadline: "2026-04-01", maxAssignees: 4 },
      { groupId: GROUP_ID },
    );

    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    expect(mockUpdateResource).toHaveBeenCalledWith({
      resourceId: "j1",
      metadataPatch: { deadline: "2026-04-01", maxAssignees: 4 },
    });
    expect(result).toEqual({ success: true, resourceId: "j1" });
  });

  it("surfaces the permission-gate denial from updateResource instead of bypassing it", async () => {
    // canModifyResource (inside updateResource) rejects a non-owner without
    // group write access; the tool must return that FORBIDDEN result verbatim.
    mockUpdateResource.mockResolvedValue({
      success: false,
      message: "You do not have permission to update this object.",
      error: { code: "FORBIDDEN" },
    });

    const result = (await tool("rivr.jobs.update").run(
      { jobId: "not-mine", status: "completed" },
      { groupId: GROUP_ID },
    )) as { success: boolean; error?: { code: string } };

    expect(mockUpdateResource).toHaveBeenCalledWith({
      resourceId: "not-mine",
      metadataPatch: { status: "completed" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FORBIDDEN");
  });

  it("validates ISO dates and never touches updateResource on bad input", () => {
    expect(() =>
      tool("rivr.jobs.update").run({ jobId: "j1", deadline: "not-a-date" }, { groupId: GROUP_ID }),
    ).toThrow(/valid ISO date/);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it("rejects an empty update (no fields to change)", () => {
    expect(() =>
      tool("rivr.jobs.update").run({ jobId: "j1" }, { groupId: GROUP_ID }),
    ).toThrow(/at least one field/);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

describe("rivr.projects.update tool", () => {
  it("normalizes timeframe + status into the metadata patch", async () => {
    mockUpdateResource.mockResolvedValue({ success: true, resourceId: "p1" });

    await tool("rivr.projects.update").run(
      { projectId: "p1", timeframe: { start: "2026-06-01" }, status: "in_progress", name: "Renamed" },
      { groupId: GROUP_ID },
    );

    expect(mockUpdateResource).toHaveBeenCalledWith({
      resourceId: "p1",
      name: "Renamed",
      description: undefined,
      metadataPatch: { timeframe: { start: "2026-06-01", end: null }, status: "in_progress" },
    });
  });

  it("rejects an invalid timeframe bound before writing", () => {
    expect(() =>
      tool("rivr.projects.update").run(
        { projectId: "p1", timeframe: { end: "whenever" } },
        { groupId: GROUP_ID },
      ),
    ).toThrow(/timeframe.end/);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

describe("buildEventListing", () => {
  it("surfaces each event's scheduling fields (date/startDate/time/location/status)", () => {
    const events: ListableResource[] = [
      {
        id: "e1",
        name: "Potluck",
        metadata: {
          date: "2026-08-15",
          time: "18:00",
          location: "Community Hall",
          status: "scheduled",
        },
      },
      {
        id: "e2",
        name: "Cleanup",
        metadata: { startDate: "2026-09-01T09:00:00Z" },
      },
    ];

    expect(buildEventListing(events)).toEqual([
      {
        id: "e1",
        name: "Potluck",
        date: "2026-08-15",
        startDate: null,
        time: "18:00",
        location: "Community Hall",
        status: "scheduled",
      },
      {
        id: "e2",
        name: "Cleanup",
        date: null,
        startDate: "2026-09-01T09:00:00Z",
        time: null,
        location: null,
        status: null,
      },
    ]);
  });

  it("tolerates null metadata", () => {
    const events: ListableResource[] = [{ id: "e1", name: "E1", metadata: null }];
    expect(buildEventListing(events)).toEqual([
      { id: "e1", name: "E1", date: null, startDate: null, time: null, location: null, status: null },
    ]);
  });
});

describe("rivr.events.list tool", () => {
  it("returns group-owned events with a count, scanning the 'event' type", async () => {
    mockGetResourcesByOwnerAndType.mockImplementation(async (_owner: string, type: string) => {
      if (type === "event") {
        return [{ id: "e1", name: "Potluck", metadata: { date: "2026-08-15", time: "18:00" } }];
      }
      return [];
    });

    const result = (await tool("rivr.events.list").run({}, { groupId: GROUP_ID })) as {
      groupId: string;
      count: number;
      events: Array<{ id: string; date: string | null; time: string | null }>;
    };

    expect(mockGetResourcesByOwnerAndType).toHaveBeenCalledWith(GROUP_ID, "event", 50);
    expect(result.groupId).toBe(GROUP_ID);
    expect(result.count).toBe(1);
    expect(result.events[0]).toMatchObject({ id: "e1", date: "2026-08-15", time: "18:00" });
  });

  it("honors an explicit limit and subgroup groupId", async () => {
    mockGetResourcesByOwnerAndType.mockResolvedValue([]);

    await tool("rivr.events.list").run({ groupId: "sub-1", limit: 5 }, { groupId: GROUP_ID });

    expect(mockGetResourcesByOwnerAndType).toHaveBeenCalledWith("sub-1", "event", 5);
  });
});

describe("rivr.events.delete tool", () => {
  it("routes through the canonical, permission-gated deleteResource", async () => {
    mockDeleteResource.mockResolvedValue({ success: true, resourceId: "e1" });

    const result = await tool("rivr.events.delete").run({ eventId: "e1" }, { groupId: GROUP_ID });

    expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    expect(mockDeleteResource).toHaveBeenCalledWith("e1");
    expect(result).toEqual({ success: true, resourceId: "e1" });
  });

  it("requires an eventId", () => {
    expect(() => tool("rivr.events.delete").run({}, { groupId: GROUP_ID })).toThrow(/eventId/);
    expect(mockDeleteResource).not.toHaveBeenCalled();
  });
});

describe("not-found vs forbidden ordering", () => {
  // The underlying updateResource/deleteResource now check existence BEFORE
  // permission, returning NOT_FOUND for a missing id instead of masking it as
  // FORBIDDEN. The tools must surface that distinct code verbatim (not collapse
  // both denials into one), so an org agent can tell "no such event" apart from
  // "you may not touch this event".
  it("rivr.events.update surfaces a NOT_FOUND result distinctly from FORBIDDEN", async () => {
    mockUpdateResource.mockResolvedValue({
      success: false,
      message: "That object does not exist or has been deleted.",
      error: { code: "NOT_FOUND" },
    });

    const result = (await tool("rivr.events.update").run(
      { eventId: "ghost", date: "2026-08-15" },
      { groupId: GROUP_ID },
    )) as { success: boolean; error?: { code: string } };

    expect(mockUpdateResource).toHaveBeenCalledWith({
      resourceId: "ghost",
      metadataPatch: { date: "2026-08-15" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("rivr.events.delete surfaces NOT_FOUND for a missing id (not FORBIDDEN)", async () => {
    mockDeleteResource.mockResolvedValue({
      success: false,
      message: "That object does not exist or has been deleted.",
      error: { code: "NOT_FOUND" },
    });

    const result = (await tool("rivr.events.delete").run(
      { eventId: "ghost" },
      { groupId: GROUP_ID },
    )) as { success: boolean; error?: { code: string } };

    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("still surfaces FORBIDDEN when the resource exists but is not writable", async () => {
    mockUpdateResource.mockResolvedValue({
      success: false,
      message: "You do not have permission to update this object.",
      error: { code: "FORBIDDEN" },
    });

    const result = (await tool("rivr.events.update").run(
      { eventId: "not-mine", date: "2026-08-15" },
      { groupId: GROUP_ID },
    )) as { success: boolean; error?: { code: string } };

    expect(result.error?.code).toBe("FORBIDDEN");
  });
});

describe("rivr.projects.create — create-path date persistence", () => {
  it("passes validated deadline, timeframe, and nested-job schedule fields through to the create action", async () => {
    mockCreateProjectResource.mockResolvedValue({ success: true, resourceId: "p1" });

    await tool("rivr.projects.create").run(
      {
        title: "Spring Build",
        description: "Build the thing",
        category: "operations",
        deadline: "2026-08-31",
        timeframe: { start: "2026-08-01", end: "2026-08-31" },
        jobs: [
          {
            title: "Frame the walls",
            description: "Framing",
            startDate: "2026-08-02",
            deadline: "2026-08-10",
            date: "2026-08-02",
          },
        ],
      },
      { groupId: GROUP_ID },
    );

    expect(mockCreateProjectResource).toHaveBeenCalledTimes(1);
    const payload = mockCreateProjectResource.mock.calls[0][0] as {
      groupId: string;
      deadline?: string;
      timeframe?: { start: string | null; end: string | null };
      jobs?: Array<Record<string, unknown>>;
    };
    expect(payload.groupId).toBe(GROUP_ID);
    expect(payload.deadline).toBe("2026-08-31");
    expect(payload.timeframe).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(payload.jobs).toHaveLength(1);
    // The job's schedule fields survive into the payload (previously dropped,
    // forcing a follow-up jobs.update to set them).
    expect(payload.jobs![0]).toMatchObject({
      title: "Frame the walls",
      startDate: "2026-08-02",
      deadline: "2026-08-10",
      date: "2026-08-02",
    });
  });

  it("validates ISO dates on the project deadline before creating", () => {
    expect(() =>
      tool("rivr.projects.create").run(
        { title: "T", description: "D", category: "c", deadline: "not-a-date" },
        { groupId: GROUP_ID },
      ),
    ).toThrow(/valid ISO date/);
    expect(mockCreateProjectResource).not.toHaveBeenCalled();
  });

  it("validates ISO dates on a nested job's schedule before creating", () => {
    expect(() =>
      tool("rivr.projects.create").run(
        {
          title: "T",
          description: "D",
          category: "c",
          jobs: [{ title: "J", description: "d", deadline: "whenever" }],
        },
        { groupId: GROUP_ID },
      ),
    ).toThrow(/valid ISO date/);
    expect(mockCreateProjectResource).not.toHaveBeenCalled();
  });
});
