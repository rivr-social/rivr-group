/**
 * Unit tests for the sovereign group site-service owner gate (Phase G / P-G4).
 *
 * The security-critical seam is {@link resolveSiteOwnerSubject}: owner identity
 * must be derived server-side from the session, and a requested `targetAgentId`
 * may only resolve to a group the caller actually manages. A client must never be
 * able to name an arbitrary owner. The DB and the helpers module are mocked so
 * this stays a pure-logic test (no Postgres, no real auth()).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuthenticatedUserId: vi.fn(),
  hasGroupWriteAccess: vi.fn(),
}));

// Stub the DB module so importing the service never opens a connection.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({
  agents: {},
  resources: {},
  siteVersions: {},
  sitePublications: {},
}));
vi.mock("@/app/actions/resource-creation/helpers", () => ({
  resolveAuthenticatedUserId: mocks.resolveAuthenticatedUserId,
  hasGroupWriteAccess: mocks.hasGroupWriteAccess,
}));

import { resolveSiteOwnerSubject } from "@/lib/builder/site-service";

beforeEach(() => {
  mocks.resolveAuthenticatedUserId.mockReset();
  mocks.hasGroupWriteAccess.mockReset();
});

describe("resolveSiteOwnerSubject", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    mocks.resolveAuthenticatedUserId.mockResolvedValueOnce(null);
    const result = await resolveSiteOwnerSubject();
    expect(result).toEqual({ error: expect.any(String), status: 401 });
    expect(mocks.hasGroupWriteAccess).not.toHaveBeenCalled();
  });

  it("defaults the owner to the session user when no target is requested", async () => {
    mocks.resolveAuthenticatedUserId.mockResolvedValueOnce("user-1");
    const result = await resolveSiteOwnerSubject();
    expect(result).toEqual({ actorId: "user-1", targetAgentId: "user-1" });
    expect(mocks.hasGroupWriteAccess).not.toHaveBeenCalled();
  });

  it("treats a target equal to the session user as self (no group check)", async () => {
    mocks.resolveAuthenticatedUserId.mockResolvedValueOnce("user-1");
    const result = await resolveSiteOwnerSubject("user-1");
    expect(result).toEqual({ actorId: "user-1", targetAgentId: "user-1" });
    expect(mocks.hasGroupWriteAccess).not.toHaveBeenCalled();
  });

  it("resolves a managed group target when the caller has write access", async () => {
    mocks.resolveAuthenticatedUserId.mockResolvedValueOnce("user-1");
    mocks.hasGroupWriteAccess.mockResolvedValueOnce(true);
    const result = await resolveSiteOwnerSubject("group-9");
    expect(result).toEqual({ actorId: "user-1", targetAgentId: "group-9" });
    expect(mocks.hasGroupWriteAccess).toHaveBeenCalledWith("user-1", "group-9");
  });

  it("rejects a target the caller does not manage with 403 (no client-named owner)", async () => {
    mocks.resolveAuthenticatedUserId.mockResolvedValueOnce("user-1");
    mocks.hasGroupWriteAccess.mockResolvedValueOnce(false);
    const result = await resolveSiteOwnerSubject("group-evil");
    expect(result).toEqual({ error: expect.any(String), status: 403 });
  });
});
