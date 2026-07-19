import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for createGovernancePollAction (group repo).
 *
 * Poll creation was the one governance create-path with no server action and no
 * UI (proposals + issues both had both). These cover the validation surface
 * (≥2 options required), the write-access gate, and the happy path that appends
 * a well-formed poll to the group agent's `metadata.polls` — the array the
 * Governance tab reads and `castGovernanceVoteAction` votes against.
 *
 * Pure-mock (no DB): mirrors the global governance-vote-action test style so it
 * runs under `pnpm test:unit`.
 */
const mocks = vi.hoisted(() => ({
  resolveAuthenticatedUserId: vi.fn(),
  hasGroupWriteAccess: vi.fn(),
  evaluateGate: vi.fn(),
  listGovernanceBadges: vi.fn(),
  getOrgShareClasses: vi.fn(),
  rateLimit: vi.fn(),
  updateFacadeExecute: vi.fn(async (_request: unknown, applyLocal: () => Promise<unknown>) => ({
    success: true,
    data: await applyLocal(),
  })),
  emitDomainEvent: vi.fn(),
  dbSelect: vi.fn(),
  dbTransaction: vi.fn(),
  txUpdateSet: vi.fn(),
  txInsertValues: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@node-rs/bcrypt", () => ({ hash: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({ op: "inArray", left, right })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  desc: vi.fn((value: unknown) => ({ op: "desc", value })),
}));

vi.mock("@/db/schema", () => ({
  agents: { id: "agents.id", type: "agents.type", metadata: "agents.metadata", deletedAt: "agents.deletedAt" },
  ledger: "ledger",
  resources: "resources",
}));

vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
    transaction: mocks.dbTransaction,
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  RATE_LIMITS: { SOCIAL: { limit: 10, windowMs: 60_000 } },
}));

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

// P2: eligibility-gate resolution + reference validation dependencies.
vi.mock("@/lib/governance-eligibility.server", () => ({
  evaluateGovernanceGateForUser: mocks.evaluateGate,
  evaluateGovernanceGatesForUser: vi.fn(),
  resolveGovernanceEligibilityFacts: vi.fn(),
  listGovernanceBadges: mocks.listGovernanceBadges,
  listGovernanceGateOptions: vi.fn(),
}));
vi.mock("@/app/actions/wallet/share-classes", () => ({
  getOrgShareClasses: mocks.getOrgShareClasses,
}));
vi.mock("@/lib/permissions", () => ({ isGroupMember: vi.fn(), check: vi.fn() }));

import { createGovernancePollAction } from "@/app/actions/resource-creation/groups";

function mockSelectRows(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  mocks.dbSelect.mockReturnValue(chain);
}

function wireTransaction() {
  mocks.txUpdateSet.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
  const tx = {
    update: vi.fn(() => ({ set: mocks.txUpdateSet })),
    insert: vi.fn(() => ({ values: mocks.txInsertValues })),
  };
  mocks.txInsertValues.mockResolvedValue(undefined);
  mocks.dbTransaction.mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => {
    await cb(tx);
  });
}

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

describe("createGovernancePollAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAuthenticatedUserId.mockResolvedValue(USER_ID);
    mocks.hasGroupWriteAccess.mockResolvedValue(true);
    mocks.evaluateGate.mockResolvedValue({ eligible: false });
    mocks.listGovernanceBadges.mockResolvedValue([]);
    mocks.getOrgShareClasses.mockResolvedValue([]);
    mocks.rateLimit.mockResolvedValue({ success: true });
    mocks.emitDomainEvent.mockResolvedValue(undefined);
    mocks.updateFacadeExecute.mockImplementation(async (_request: unknown, applyLocal: () => Promise<unknown>) => ({
      success: true,
      data: await applyLocal(),
    }));
    wireTransaction();
  });

  it("rejects a poll with fewer than two non-empty options", async () => {
    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Lunch?",
      options: ["Only one", "   "],
      duration: 7,
    });

    expect(result).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it("requires a question", async () => {
    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "   ",
      options: ["A", "B"],
      duration: 7,
    });

    expect(result).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it("rejects a caller without group write access before writing (default propose gate)", async () => {
    mocks.hasGroupWriteAccess.mockResolvedValue(false);
    // The propose-authority fallback loads the group meta: no proposeGate set →
    // admins only → reject without ever evaluating a widened gate.
    mockSelectRows([{ metadata: {} }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Meeting time?",
      options: ["Tue", "Thu"],
      duration: 7,
    });

    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(mocks.evaluateGate).not.toHaveBeenCalled();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it("lets a non-admin propose when the org widened the propose gate to members", async () => {
    mocks.hasGroupWriteAccess.mockResolvedValue(false);
    mocks.evaluateGate.mockResolvedValue({ eligible: true });
    mockSelectRows([{ metadata: { governance: { proposeGate: { kind: "member" } }, polls: [] } }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Meeting time?",
      options: ["Tue", "Thu"],
      duration: 7,
    });

    expect(result.success).toBe(true);
    expect(mocks.evaluateGate).toHaveBeenCalledWith(USER_ID, GROUP_ID, { kind: "member" });
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1);
  });

  it("stores the sanitized vote-eligibility gate on the poll (default member)", async () => {
    mockSelectRows([{ metadata: { polls: [] } }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Lunch?",
      options: ["A", "B"],
      duration: 7,
    });

    expect(result.success).toBe(true);
    const [meta] = mocks.txUpdateSet.mock.calls[0] as [{ metadata: { polls: unknown[] } }];
    const created = (meta.metadata.polls as Array<Record<string, unknown>>)[0];
    expect(created.eligibility).toEqual({ vote: { kind: "member" } });
  });

  it("stores a badge-holder vote gate after verifying the badge belongs to the group", async () => {
    mocks.listGovernanceBadges.mockResolvedValue([{ id: "badge-1", name: "Steward" }]);
    mockSelectRows([{ metadata: { polls: [] } }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Lunch?",
      options: ["A", "B"],
      duration: 7,
      voteEligibility: { kind: "badge-holder", badgeId: "badge-1" },
    });

    expect(result.success).toBe(true);
    const [meta] = mocks.txUpdateSet.mock.calls[0] as [{ metadata: { polls: unknown[] } }];
    const created = (meta.metadata.polls as Array<Record<string, unknown>>)[0];
    expect(created.eligibility).toEqual({ vote: { kind: "badge-holder", badgeId: "badge-1" } });
  });

  it("rejects a vote gate referencing another group's badge", async () => {
    mocks.listGovernanceBadges.mockResolvedValue([{ id: "badge-1", name: "Steward" }]);
    mockSelectRows([{ metadata: { polls: [] } }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "Lunch?",
      options: ["A", "B"],
      duration: 7,
      voteEligibility: { kind: "badge-holder", badgeId: "badge-foreign" },
    });

    expect(result).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it("appends a well-formed poll to group metadata on success", async () => {
    mockSelectRows([{ metadata: { polls: [{ id: "poll-existing" }] } }]);

    const result = await createGovernancePollAction({
      groupId: GROUP_ID,
      question: "  When should we meet?  ",
      description: "  pick one  ",
      options: ["Tuesday", " Thursday ", ""],
      duration: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resourceId).toMatch(/^poll-/);
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1);

    const [meta] = mocks.txUpdateSet.mock.calls[0] as [{ metadata: { polls: unknown[] } }];
    const polls = meta.metadata.polls as Array<Record<string, unknown>>;
    // Existing poll preserved + the new one appended.
    expect(polls).toHaveLength(2);
    const created = polls[1];
    expect(created.question).toBe("When should we meet?");
    expect(created.description).toBe("pick one");
    expect(created.totalVotes).toBe(0);
    const options = created.options as Array<{ text: string; votes: number }>;
    // Empty option dropped; whitespace trimmed.
    expect(options.map((o) => o.text)).toEqual(["Tuesday", "Thursday"]);
    expect(options.every((o) => o.votes === 0)).toBe(true);
  });
});
