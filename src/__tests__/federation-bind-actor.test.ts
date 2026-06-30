import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for bindAuthorizedFederationActor() — the trust-rail authority
 * gate used by the federation mutations endpoint (F1).
 *
 * The peer-secret path NEVER trusts the body-supplied `actorId` on the strength
 * of the shared secret alone. It binds to a receiver-LOCAL agent id through a
 * PRE-EXISTING federation_entity_map row, accepting the actor in EITHER key
 * direction and always returning the receiver-local id:
 *   (2a) requestedActorId IS this instance's local id  → returns it unchanged.
 *   (2b) requestedActorId is the forwarder's local id (our externalEntityId)
 *        → resolves to the mapped localEntityId.
 * A request with no binding row in either direction is REJECTED — identity is
 * never invented from a peer secret.
 *
 * Regression target: Camalot (person, actor aa29fa2d) posting AS Regen Hub
 * (this group), where Cameron is the group creator/admin under local id
 * ea079076. Authority checks (hasGroupWriteAccess) must run against ea079076.
 *
 * All database interactions are mocked.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      federationEntityMap: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
}));

// federation-auth.ts also imports these; stub to keep the module loadable.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn() }));
vi.mock("@/db/schema", () => ({
  federationEntityMap: {
    originNodeId: "origin_node_id",
    externalEntityId: "external_entity_id",
    entityType: "entity_type",
    localEntityId: "local_entity_id",
  },
  nodePeers: {},
  nodes: {},
}));

import { bindAuthorizedFederationActor } from "@/lib/federation-auth";

const PEER_NODE_ID = "44444444-4444-4444-4444-444444444444";
const FORWARDER_LOCAL_ID = "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667"; // Cameron on Camalot
const RECEIVER_LOCAL_ID = "ea079076-e7d0-489e-9cb2-1e6275d0d1cf"; // Cameron on Regen Hub

describe("bindAuthorizedFederationActor", () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
  });

  it("rejects an unauthorized authorization", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: false, reason: "nope" },
      RECEIVER_LOCAL_ID,
    );
    expect(result.authorized).toBe(false);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("rejects when no actorId is requested", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      undefined,
    );
    expect(result.authorized).toBe(false);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("session auth binds when the requested actor matches the session", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, actorId: RECEIVER_LOCAL_ID },
      RECEIVER_LOCAL_ID,
    );
    expect(result).toEqual({ authorized: true, actorId: RECEIVER_LOCAL_ID });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("session auth rejects when the requested actor differs from the session", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, actorId: RECEIVER_LOCAL_ID },
      FORWARDER_LOCAL_ID,
    );
    expect(result.authorized).toBe(false);
  });

  it("(2a) peer auth binds the local id directly when a localEntityId row exists", async () => {
    // First lookup (localEntityId = requestedActorId) hits.
    mockFindFirst.mockResolvedValueOnce({ id: "map-row" });

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      RECEIVER_LOCAL_ID,
    );

    expect(result).toEqual({ authorized: true, actorId: RECEIVER_LOCAL_ID });
    // Local match short-circuits — the external lookup is not run.
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it("(2b) peer auth resolves the forwarder's external id to the local id", async () => {
    // Local lookup misses, external lookup (externalEntityId = requestedActorId) hits.
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ localEntityId: RECEIVER_LOCAL_ID });

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      FORWARDER_LOCAL_ID,
    );

    expect(result).toEqual({ authorized: true, actorId: RECEIVER_LOCAL_ID });
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it("peer auth rejects when neither key direction maps the actor (never invents identity)", async () => {
    mockFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      FORWARDER_LOCAL_ID,
    );

    expect(result.authorized).toBe(false);
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it("rejects admin-key auth with neither a session nor a peer node (no impersonation)", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true },
      RECEIVER_LOCAL_ID,
    );
    expect(result.authorized).toBe(false);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
