/**
 * Unit tests for {@link authorizeKgScope} (GRP-SEC-001).
 *
 * The federated KG handlers must authorize the caller-supplied `scope_id`
 * against the VERIFIED principal, never trust it as an ambient claim. These
 * tests pin every branch of that decision: self-scope, group read/write, and
 * the catch-all deny for foreign non-group scopes. The underlying permission
 * checks are mocked so the test exercises the authorization logic in
 * isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isGroupMember: vi.fn(),
  canPostToGroup: vi.fn(),
  hasGroupWriteAccess: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({
  isGroupMember: mocks.isGroupMember,
}));

vi.mock("@/app/actions/resource-creation/helpers", () => ({
  canPostToGroup: mocks.canPostToGroup,
  hasGroupWriteAccess: mocks.hasGroupWriteAccess,
}));

import { authorizeKgScope } from "../kg-scope-authz";

const ACTOR = "actor-1";
const GROUP = "group-9";

beforeEach(() => {
  mocks.isGroupMember.mockReset();
  mocks.canPostToGroup.mockReset();
  mocks.hasGroupWriteAccess.mockReset();
  // Default-deny so any unmocked path fails closed.
  mocks.isGroupMember.mockResolvedValue({ isMember: false });
  mocks.canPostToGroup.mockResolvedValue(false);
  mocks.hasGroupWriteAccess.mockResolvedValue(false);
});

describe("authorizeKgScope — self scope", () => {
  it("always allows the principal acting on its own id, regardless of mode", async () => {
    const write = await authorizeKgScope(ACTOR, "person", ACTOR, "write");
    const read = await authorizeKgScope(ACTOR, "person", ACTOR, "read");
    expect(write).toEqual({ ok: true });
    expect(read).toEqual({ ok: true });
    // No group checks needed for self scope.
    expect(mocks.canPostToGroup).not.toHaveBeenCalled();
    expect(mocks.isGroupMember).not.toHaveBeenCalled();
  });
});

describe("authorizeKgScope — group WRITE", () => {
  it("allows when the principal may post to the group", async () => {
    mocks.canPostToGroup.mockResolvedValue(true);
    const result = await authorizeKgScope(ACTOR, "group", GROUP, "write");
    expect(result.ok).toBe(true);
    expect(mocks.canPostToGroup).toHaveBeenCalledWith(ACTOR, GROUP);
  });

  it("denies when the principal cannot post to the group", async () => {
    mocks.canPostToGroup.mockResolvedValue(false);
    const result = await authorizeKgScope(ACTOR, "group", GROUP, "write");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not authorized to write/i);
  });
});

describe("authorizeKgScope — group READ", () => {
  it("allows an active member", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: true, role: "member" });
    const result = await authorizeKgScope(ACTOR, "group", GROUP, "read");
    expect(result.ok).toBe(true);
    expect(mocks.isGroupMember).toHaveBeenCalledWith(ACTOR, GROUP);
  });

  it("allows a non-member who holds manage access", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: false });
    mocks.hasGroupWriteAccess.mockResolvedValue(true);
    const result = await authorizeKgScope(ACTOR, "group", GROUP, "read");
    expect(result.ok).toBe(true);
  });

  it("denies a non-member without manage access", async () => {
    mocks.isGroupMember.mockResolvedValue({ isMember: false });
    mocks.hasGroupWriteAccess.mockResolvedValue(false);
    const result = await authorizeKgScope(ACTOR, "group", GROUP, "read");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a member/i);
  });
});

describe("authorizeKgScope — foreign non-group scope", () => {
  it("denies a non-group scope addressed at another entity's id", async () => {
    const result = await authorizeKgScope(ACTOR, "person", "someone-else", "read");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not authorized for scope_type/i);
    expect(mocks.isGroupMember).not.toHaveBeenCalled();
    expect(mocks.canPostToGroup).not.toHaveBeenCalled();
  });

  it("denies an unknown scope type even in write mode", async () => {
    const result = await authorizeKgScope(ACTOR, "global", "global-kg", "write");
    expect(result.ok).toBe(false);
  });
});
