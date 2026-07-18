import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for castGovernanceVoteAction (group repo) — the P0 governance
 * defects fixed 2026-07-17:
 *   1. Members-only voting — being logged in is no longer sufficient; a vote
 *      requires active membership in the owning group.
 *   2. Tally write-back — the Governance tab reads vote counts from the group
 *      agent's `metadata` (polls[].options[].votes / totalVotes,
 *      proposals[].votes), but votes only persisted to the ledger, so the bars
 *      read 0% forever. The action now recomputes the authoritative tally from
 *      the ACTIVE governance-vote ledger rows and writes it back — recomputing
 *      (not incrementing) so a CHANGED vote is correct.
 *
 * Pure-mock (no DB): mirrors the global governance-vote-action test style so it
 * runs under `pnpm test:unit`.
 */
const mocks = vi.hoisted(() => ({
  resolveAuthenticatedUserId: vi.fn(),
  hasGroupWriteAccess: vi.fn(),
  isGroupMember: vi.fn(),
  rateLimit: vi.fn(),
  updateFacadeExecute: vi.fn(async (_request: unknown, applyLocal: () => Promise<unknown>) => ({
    success: true,
    data: await applyLocal(),
  })),
  emitDomainEvent: vi.fn(),
  dbExecute: vi.fn(),
  dbInsert: vi.fn(),
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@node-rs/bcrypt", () => ({ hash: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({ op: "inArray", left, right })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    {},
  ),
  desc: vi.fn((value: unknown) => ({ op: "desc", value })),
}));

vi.mock("@/db/schema", () => ({
  agents: { id: "agents.id", type: "agents.type", metadata: "agents.metadata", deletedAt: "agents.deletedAt" },
  ledger: { verb: "ledger.verb", isActive: "ledger.isActive", objectId: "ledger.objectId", metadata: "ledger.metadata" },
  resources: "resources",
}));

vi.mock("@/db", () => ({
  db: {
    execute: mocks.dbExecute,
    insert: mocks.dbInsert,
    select: mocks.dbSelect,
    update: mocks.dbUpdate,
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  RATE_LIMITS: { SOCIAL: { limit: 10, windowMs: 60_000 } },
}));

vi.mock("@/lib/permissions", () => ({ isGroupMember: mocks.isGroupMember }));

vi.mock("@/lib/ai", () => ({ embedAgent: vi.fn(), scheduleEmbedding: vi.fn() }));
vi.mock("@/lib/matrix-groups", () => ({ ensureGroupMatrixRoom: vi.fn() }));
vi.mock("@/lib/murmurations", () => ({ syncMurmurationsProfilesForActor: vi.fn() }));
vi.mock("@/lib/entitlements-server", () => ({ hasCapability: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ isOrganizationGroupType: vi.fn() }));

vi.mock("@/lib/federation", () => ({
  updateFacade: { execute: mocks.updateFacadeExecute },
  emitDomainEvent: mocks.emitDomainEvent,
  EVENT_TYPES: { RESOURCE_CREATED: "resource.created" },
}));

vi.mock("@/app/actions/resource-creation/helpers", () => ({
  resolveAuthenticatedUserId: mocks.resolveAuthenticatedUserId,
  hasGroupWriteAccess: mocks.hasGroupWriteAccess,
}));

import { castGovernanceVoteAction } from "@/app/actions/resource-creation/groups";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

/**
 * Queue db.select() results in call order. The group lookup terminates at
 * `.limit()`; the tally recompute terminates at `.where()` (no limit) — so each
 * returned chain is BOTH a thenable (resolves the queued rows when awaited
 * directly) and exposes a `.limit()` that resolves the same rows.
 */
function queueSelect(...resultsInOrder: unknown[][]) {
  let i = 0;
  mocks.dbSelect.mockImplementation(() => {
    const rows = resultsInOrder[i++] ?? [];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return chain;
  });
}

function lastWriteBackMetadata(): Record<string, unknown> | undefined {
  const call = mocks.updateSet.mock.calls.at(-1);
  return call ? (call[0] as { metadata: Record<string, unknown> }).metadata : undefined;
}

describe("castGovernanceVoteAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAuthenticatedUserId.mockResolvedValue(USER_ID);
    mocks.rateLimit.mockResolvedValue({ success: true });
    mocks.updateFacadeExecute.mockImplementation(async (_request: unknown, applyLocal: () => Promise<unknown>) => ({
      success: true,
      data: await applyLocal(),
    }));
    mocks.dbExecute.mockResolvedValue(undefined);
    mocks.dbInsert.mockReturnValue({ values: vi.fn(() => Promise.resolve()) });
    mocks.updateSet.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
    mocks.dbUpdate.mockReturnValue({ set: mocks.updateSet });
  });

  it("rejects non-members before writing a governance vote", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: false });

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "proposal-1",
      targetType: "proposal",
      vote: "yes",
    });

    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("rejects governance target ids that are not attached to the group", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect([{ metadata: { proposals: [{ id: "proposal-other" }] } }]);

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "proposal-1",
      targetType: "proposal",
      vote: "yes",
    });

    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("recomputes a proposal's yes/no/abstain tally from active ledger rows", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect(
      // group lookup
      [{ metadata: { proposals: [{ id: "proposal-1", title: "Adopt", votes: { yes: 0, no: 0, abstain: 0 } }] } }],
      // active governance-vote rows after the insert (2 yes, 1 no)
      [{ vote: "yes" }, { vote: "yes" }, { vote: "no" }],
    );

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "proposal-1",
      targetType: "proposal",
      vote: "yes",
    });

    expect(result).toMatchObject({ success: true });
    expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
    const meta = lastWriteBackMetadata();
    const proposal = (meta?.proposals as Record<string, unknown>[])[0];
    expect(proposal.votes).toEqual({ yes: 2, no: 1, abstain: 0 });
  });

  it("recomputes a poll's per-option votes and totalVotes by option id", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect(
      [{ metadata: { polls: [{ id: "poll-1", question: "Lunch?", options: [{ id: "opt-a", votes: 0 }, { id: "opt-b", votes: 0 }], totalVotes: 0 }] } }],
      // active rows: 3 for opt-a, 1 for opt-b
      [{ vote: "opt-a" }, { vote: "opt-a" }, { vote: "opt-a" }, { vote: "opt-b" }],
    );

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "poll-1",
      targetType: "poll",
      vote: "opt-a",
    });

    expect(result).toMatchObject({ success: true });
    const meta = lastWriteBackMetadata();
    const poll = (meta?.polls as Record<string, unknown>[])[0];
    expect(poll.totalVotes).toBe(4);
    expect(poll.options).toEqual([
      { id: "opt-a", votes: 3 },
      { id: "opt-b", votes: 1 },
    ]);
  });

  it("validates + tallies a P1 approval-ballot poll and writes back poll.tally", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect(
      // group lookup: an approval-style poll with two options
      [
        {
          metadata: {
            polls: [
              {
                id: "poll-1",
                ballotStyle: "approval",
                options: [{ id: "opt-a", text: "A", votes: 0 }, { id: "opt-b", text: "B", votes: 0 }],
                totalVotes: 0,
              },
            ],
          },
        },
      ],
      // active ballots after insert
      [
        { ballot: { style: "approval", selections: ["opt-a"] } },
        { ballot: { style: "approval", selections: ["opt-a", "opt-b"] } },
      ],
    );

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "poll-1",
      targetType: "poll",
      ballot: { selections: ["opt-a", "opt-b"] },
    });

    expect(result).toMatchObject({ success: true });
    const poll = (lastWriteBackMetadata()?.polls as Record<string, unknown>[])[0];
    const opts = poll.options as Record<string, unknown>[];
    expect(opts.find((o) => o.id === "opt-a")!.votes).toBe(2);
    expect(opts.find((o) => o.id === "opt-b")!.votes).toBe(1);
    const tally = poll.tally as { style: string; totalVotes: number };
    expect(tally.style).toBe("approval");
    expect(tally.totalVotes).toBe(2);
  });

  it("rejects an over-budget quadratic ballot before writing", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect([
      {
        metadata: {
          polls: [
            {
              id: "poll-1",
              ballotStyle: "quadratic",
              creditsPerVoter: 100,
              options: [{ id: "opt-a", votes: 0 }, { id: "opt-b", votes: 0 }],
              totalVotes: 0,
            },
          ],
        },
      },
    ]);

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "poll-1",
      targetType: "poll",
      ballot: { credits: { "opt-a": 80, "opt-b": 80 } }, // 160 > 100
    });

    expect(result).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("does not double-count a changed vote (re-vote recompute)", async () => {
    // The user previously voted yes; they now vote no. The prior row is
    // deactivated, so the active-rows recompute sees only the single 'no'.
    mocks.isGroupMember.mockResolvedValue({ isMember: true });
    queueSelect(
      [{ metadata: { proposals: [{ id: "proposal-1", votes: { yes: 1, no: 0, abstain: 0 } }] } }],
      [{ vote: "no" }],
    );

    const result = await castGovernanceVoteAction({
      groupId: GROUP_ID,
      targetId: "proposal-1",
      targetType: "proposal",
      vote: "no",
    });

    expect(result).toMatchObject({ success: true });
    // The deactivation UPDATE ran before the recompute.
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    const meta = lastWriteBackMetadata();
    const proposal = (meta?.proposals as Record<string, unknown>[])[0];
    expect(proposal.votes).toEqual({ yes: 0, no: 1, abstain: 0 });
  });
});
