import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the group member-capability weave (C4 → verified-principal):
 * - resolveGroupMemberCapability: per-group toggle policy, default-on.
 * - hasGroupManageAccess: admin gate (delegates to isGroupAdmin) that no longer
 *   trusts a plain join/belong row.
 * - canPostToGroup: content gate = manage OR (toggle-on AND active membership).
 *
 * The group app's manage gate uses the established `isGroupAdmin` primitive
 * (admin/moderator ledger role + creatorId/adminIds metadata) rather than the
 * person app's own/manage ledger SQL, so that dependency is mocked here.
 */

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbExecute: vi.fn(),
  hasEntitlement: vi.fn(),
  isGroupAdmin: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(), RATE_LIMITS: {} }));
vi.mock("@/lib/ai", () => ({ embedResource: vi.fn(), scheduleEmbedding: vi.fn() }));
vi.mock("@/lib/murmurations", () => ({ syncMurmurationsProfilesForActor: vi.fn() }));
vi.mock("@/lib/federation", () => ({
  ensureLocalNode: vi.fn(),
  queueEntityExportEvents: vi.fn(),
}));
vi.mock("@/lib/federation/execution-context", () => ({
  getExecutionContext: vi.fn(() => null),
}));
vi.mock("@/lib/billing", () => ({ hasEntitlement: mocks.hasEntitlement }));
vi.mock("@/app/actions/group-admin", () => ({ isGroupAdmin: mocks.isGroupAdmin }));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }),
  inArray: (left: unknown, values: unknown[]) => ({ op: "inArray", left, values }),
  sql: (...args: unknown[]) => ({ op: "sql", args }),
}));
vi.mock("@/db/schema", () => ({
  agents: { id: "agents.id", metadata: "agents.metadata", type: { enumValues: ["organization"] } },
  ledger: {},
  resources: {},
}));
vi.mock("@/db", () => ({ db: { select: mocks.dbSelect, execute: mocks.dbExecute } }));

import { resolveGroupMemberCapability } from "@/app/actions/resource-creation/types";
import {
  hasGroupManageAccess,
  canPostToGroup,
} from "@/app/actions/resource-creation/helpers";

const USER = "11111111-1111-1111-1111-111111111111";
const GROUP = "22222222-2222-2222-2222-222222222222";

let selectQueue: unknown[][] = [];
let executeQueue: unknown[][] = [];

function queueSelect(rows: unknown[]) {
  selectQueue.push(rows);
}
function queueExecute(rows: unknown[]) {
  executeQueue.push(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  executeQueue = [];
  mocks.hasEntitlement.mockResolvedValue(true);
  mocks.isGroupAdmin.mockResolvedValue(false);
  mocks.dbSelect.mockImplementation(() => {
    const rows = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(rows);
    return chain;
  });
  mocks.dbExecute.mockImplementation(() => Promise.resolve(executeQueue.shift() ?? []));
});

describe("resolveGroupMemberCapability", () => {
  it("defaults content verbs on when no policy is set", () => {
    expect(resolveGroupMemberCapability({}, "create")).toBe(true);
    expect(resolveGroupMemberCapability({}, "comment")).toBe(true);
    expect(resolveGroupMemberCapability({}, "react")).toBe(true);
    expect(resolveGroupMemberCapability(null, "create")).toBe(true);
  });

  it("honors an explicit per-verb toggle", () => {
    const meta = { memberCapabilities: { create: false, comment: true } };
    expect(resolveGroupMemberCapability(meta, "create")).toBe(false);
    expect(resolveGroupMemberCapability(meta, "comment")).toBe(true);
    // unset verb falls back to default-on
    expect(resolveGroupMemberCapability(meta, "react")).toBe(true);
  });

  it("ignores malformed policy values", () => {
    expect(resolveGroupMemberCapability({ memberCapabilities: "nope" }, "create")).toBe(true);
    expect(resolveGroupMemberCapability({ memberCapabilities: { create: 1 } }, "create")).toBe(true);
  });
});

describe("hasGroupManageAccess", () => {
  it("returns false for a non-group / missing agent", async () => {
    queueSelect([]);
    expect(await hasGroupManageAccess(USER, GROUP)).toBe(false);
    expect(mocks.isGroupAdmin).not.toHaveBeenCalled();
  });

  it("allows an admin (isGroupAdmin)", async () => {
    queueSelect([{ id: GROUP }]);
    mocks.isGroupAdmin.mockResolvedValue(true);
    expect(await hasGroupManageAccess(USER, GROUP)).toBe(true);
  });

  it("denies a non-admin", async () => {
    queueSelect([{ id: GROUP }]);
    mocks.isGroupAdmin.mockResolvedValue(false);
    expect(await hasGroupManageAccess(USER, GROUP)).toBe(false);
  });
});

describe("canPostToGroup", () => {
  it("allows a manager (admin) unconditionally", async () => {
    queueSelect([{ id: GROUP, metadata: {} }]); // canPostToGroup lookup
    queueSelect([{ id: GROUP }]); // hasGroupManageAccess lookup
    mocks.isGroupAdmin.mockResolvedValue(true);
    expect(await canPostToGroup(USER, GROUP)).toBe(true);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it("allows a plain member when the group toggle is default-on", async () => {
    queueSelect([{ id: GROUP, metadata: {} }]); // canPostToGroup
    queueSelect([{ id: GROUP }]); // manage lookup
    mocks.isGroupAdmin.mockResolvedValue(false);
    queueExecute([{ id: "membership-1" }]); // active membership edge
    expect(await canPostToGroup(USER, GROUP)).toBe(true);
  });

  it("denies a member when the group toggle is off", async () => {
    queueSelect([{ id: GROUP, metadata: { memberCapabilities: { create: false } } }]);
    queueSelect([{ id: GROUP }]);
    mocks.isGroupAdmin.mockResolvedValue(false);
    expect(await canPostToGroup(USER, GROUP)).toBe(false);
    // membership is never even queried once the toggle blocks the verb
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it("denies a non-member even with the toggle on", async () => {
    queueSelect([{ id: GROUP, metadata: {} }]);
    queueSelect([{ id: GROUP }]);
    mocks.isGroupAdmin.mockResolvedValue(false);
    queueExecute([]); // no membership edge
    expect(await canPostToGroup(USER, GROUP)).toBe(false);
  });

  it("denies a member who lacks a required paid tier", async () => {
    mocks.hasEntitlement.mockResolvedValue(false);
    queueSelect([{ id: GROUP, metadata: { writeMembershipTier: "seller" } }]);
    queueSelect([{ id: GROUP }]);
    mocks.isGroupAdmin.mockResolvedValue(false);
    expect(await canPostToGroup(USER, GROUP)).toBe(false);
  });
});
