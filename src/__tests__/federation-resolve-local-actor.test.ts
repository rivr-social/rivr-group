import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for resolveLocalActorId() — the receiver-side identity
 * normalization used by the federation mutations endpoint.
 *
 * A human has a distinct agent id on each sovereign instance. When they act
 * cross-instance (e.g. posting AS a group they administer), the forwarding
 * instance sends ITS local actor id. The receiver must map that remote id to
 * its OWN local agent id (via federation_entity_map) before authority checks,
 * otherwise hasGroupWriteAccess() runs against an id with no membership edge
 * and the action is wrongly rejected as FORBIDDEN.
 *
 * Regression target: Camalot (person, actor aa29fa2d) posting AS Regen Hub
 * (group), where Cameron is the group creator/admin under local id ea079076.
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

import { resolveLocalActorId } from "@/lib/federation-auth";

const CAMERON_NODE_ID = "44444444-4444-4444-4444-444444444444";
const CAMERON_ON_CAMALOT = "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667";
const CAMERON_ON_REGENHUB = "ea079076-e7d0-489e-9cb2-1e6275d0d1cf";

describe("resolveLocalActorId", () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
  });

  it("maps a peer-supplied remote actor id to the local agent id when a mapping exists", async () => {
    mockFindFirst.mockResolvedValueOnce({ localEntityId: CAMERON_ON_REGENHUB });

    const result = await resolveLocalActorId(CAMERON_NODE_ID, CAMERON_ON_CAMALOT);

    expect(result).toBe(CAMERON_ON_REGENHUB);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns the original id unchanged when no mapping exists (never invents identity)", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await resolveLocalActorId(CAMERON_NODE_ID, CAMERON_ON_CAMALOT);

    expect(result).toBe(CAMERON_ON_CAMALOT);
  });

  it("returns the original id without a DB call when origin node id is absent", async () => {
    const result = await resolveLocalActorId(undefined, CAMERON_ON_CAMALOT);

    expect(result).toBe(CAMERON_ON_CAMALOT);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("degrades to the original id if the mapping lookup throws", async () => {
    mockFindFirst.mockRejectedValueOnce(new Error("db down"));

    const result = await resolveLocalActorId(CAMERON_NODE_ID, CAMERON_ON_CAMALOT);

    expect(result).toBe(CAMERON_ON_CAMALOT);
  });
});
