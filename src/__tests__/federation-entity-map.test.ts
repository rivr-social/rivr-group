import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * Unit tests for the federation entity map / namespace mapping feature.
 *
 * Verifies that importFederationEvents() maps remote entity IDs to local
 * UUIDs via the federation_entity_map table, preventing ID collisions
 * between remote and local entities.
 *
 * All database interactions are mocked.
 */

// ---------------------------------------------------------------------------
// Predictable UUID generation
// ---------------------------------------------------------------------------

let uuidCallIndex = 0;
const GENERATED_UUIDS = [
  "aaaaaaaa-0001-0001-0001-000000000001",
  "aaaaaaaa-0002-0002-0002-000000000002",
  "aaaaaaaa-0003-0003-0003-000000000003",
  "aaaaaaaa-0004-0004-0004-000000000004",
] as const;

vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
  const id = GENERATED_UUIDS[uuidCallIndex % GENERATED_UUIDS.length];
  uuidCallIndex++;
  return id;
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn().mockReturnValue([{ id: "mock-dead-letter-id" }]);

// Mock federation-auth to avoid @/auth -> next/server import chain
vi.mock("@/lib/federation-auth", () => ({
  generatePeerSecret: () => ({ secret: "mock-secret", hash: "mock-hash" }),
  hashPeerSecret: (s: string) => `hashed-${s}`,
  authorizeFederationRequest: vi.fn(),
  validateFederationConfig: vi.fn(),
}));

// Mock federation-audit to avoid import chain issues
vi.mock("@/lib/federation-audit", () => ({
  logFederationAudit: vi.fn(),
  logDeadLetter: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      nodes: { findFirst: (...args: unknown[]) => mockFindFirst("nodes.findFirst", ...args) },
      nodePeers: { findFirst: (...args: unknown[]) => mockFindFirst("nodePeers.findFirst", ...args) },
      federationEntityMap: { findFirst: (...args: unknown[]) => mockFindFirst("federationEntityMap.findFirst", ...args) },
      agents: { findFirst: (...args: unknown[]) => mockFindFirst("agents.findFirst", ...args) },
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (...vArgs: unknown[]) => {
          mockValues(...vArgs);
          return {
            onConflictDoNothing: (...cArgs: unknown[]) => {
              mockOnConflictDoNothing(...cArgs);
              return { returning: mockReturning };
            },
            returning: mockReturning,
          };
        },
      };
    },
  },
}));

vi.mock("@/lib/federation-crypto", () => ({
  generateNodeKeyPair: vi.fn(),
  signPayload: vi.fn(),
  verifyPayloadSignature: vi.fn(() => true),
}));

import type { VisibilityLevel } from "@/db/schema";

// Dynamic import so mocks are in place
async function loadFederationModule() {
  return import("@/lib/federation");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_NODE_ID = "local-node-aaa";
const PEER_NODE_ID = "peer-node-bbb";
const PEER_SLUG = "peer-basin";
const PEER_PUBLIC_KEY = "mock-public-key";

const REMOTE_AGENT_ID = "remote-agent-111";
const REMOTE_RESOURCE_ID = "remote-resource-222";
const REMOTE_OWNER_ID = "remote-owner-333";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeerNode() {
  return {
    id: PEER_NODE_ID,
    slug: PEER_SLUG,
    displayName: "Peer Basin",
    role: "basin",
    baseUrl: "https://peer-basin.example.com",
    publicKey: PEER_PUBLIC_KEY,
    isHosted: false,
    metadata: {},
  };
}

function makeTrustedLink() {
  return {
    id: "link-123",
    localNodeId: LOCAL_NODE_ID,
    peerNodeId: PEER_NODE_ID,
    trustState: "trusted",
    metadata: {},
  };
}

function makeAgentEvent(overrides: Partial<{
  visibility: VisibilityLevel;
  signature: string;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    entityType: "agent",
    eventType: "upsert",
    visibility: (overrides.visibility ?? "public") as VisibilityLevel,
    signature: overrides.signature ?? "valid-signature",
    payload: overrides.payload ?? {
      id: REMOTE_AGENT_ID,
      name: "Remote Agent",
      type: "person",
      description: "An agent from a peer node",
      image: null,
      metadata: { originalField: "kept" },
      parentId: null,
      pathIds: null,
    },
  };
}

function makeResourceEvent(overrides: Partial<{
  visibility: VisibilityLevel;
  signature: string;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    entityType: "resource",
    eventType: "upsert",
    visibility: (overrides.visibility ?? "public") as VisibilityLevel,
    signature: overrides.signature ?? "valid-signature",
    payload: overrides.payload ?? {
      id: REMOTE_RESOURCE_ID,
      name: "Remote Document",
      type: "document",
      description: "A resource from a peer node",
      ownerId: REMOTE_OWNER_ID,
      metadata: {},
      tags: ["federated"],
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  uuidCallIndex = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importFederationEvents - entity namespace mapping", () => {
  function setupStandardMocks(entityMapResults: Record<string, unknown | null> = {}) {
    mockFindFirst.mockImplementation((method: string) => {
      if (method === "nodes.findFirst") return makePeerNode();
      if (method === "nodePeers.findFirst") return makeTrustedLink();

      if (method === "federationEntityMap.findFirst") {
        const callCount = mockFindFirst.mock.calls
          .filter(([m]: [string]) => m === "federationEntityMap.findFirst").length;
        const key = `entityMap_${callCount}`;
        return entityMapResults[key] ?? null;
      }

      if (method === "agents.findFirst") {
        return { id: "some-owner", name: "Owner Agent", type: "person" };
      }

      return null;
    });
  }

  it("creates a mapping on first import and uses a new local UUID", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()],
    });

    // The entity map insert should have been called with a generated local ID
    const entityMapInsertCalls = mockValues.mock.calls.filter(
      (call) => call[0]?.externalEntityId === REMOTE_AGENT_ID
    );
    expect(entityMapInsertCalls.length).toBe(1);
    expect(entityMapInsertCalls[0][0]).toMatchObject({
      originNodeId: PEER_NODE_ID,
      externalEntityId: REMOTE_AGENT_ID,
      entityType: "agent",
    });
    // The local ID should be a generated UUID, NOT the remote ID
    const generatedLocalId = entityMapInsertCalls[0][0].localEntityId;
    expect(generatedLocalId).not.toBe(REMOTE_AGENT_ID);
    expect(typeof generatedLocalId).toBe("string");
    expect(generatedLocalId.length).toBeGreaterThan(0);

    // The agent insert should use the mapped local ID, NOT the remote ID
    const agentInsertCalls = mockValues.mock.calls.filter(
      (call) => call[0]?.name === "Remote Agent" && !call[0]?.externalEntityId
    );
    expect(agentInsertCalls.length).toBe(1);
    expect(agentInsertCalls[0][0].id).toBe(generatedLocalId);
    expect(agentInsertCalls[0][0].id).not.toBe(REMOTE_AGENT_ID);
  });

  it("reuses existing mapping on re-import", async () => {
    const existingMapping = {
      id: "map-existing",
      originNodeId: PEER_NODE_ID,
      externalEntityId: REMOTE_AGENT_ID,
      localEntityId: "previously-mapped-uuid",
      entityType: "agent",
    };

    setupStandardMocks({ entityMap_1: existingMapping });

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()],
    });

    // The agent upsert should use the previously mapped ID
    const agentInsertCalls = mockValues.mock.calls.filter(
      (call) => call[0]?.name === "Remote Agent" && !call[0]?.externalEntityId
    );
    expect(agentInsertCalls.length).toBe(1);
    expect(agentInsertCalls[0][0].id).toBe("previously-mapped-uuid");

    // No new entity map entry should have been created for this entity
    const newEntityMapInserts = mockValues.mock.calls.filter(
      (call) => call[0]?.externalEntityId === REMOTE_AGENT_ID
    );
    expect(newEntityMapInserts.length).toBe(0);
  });

  it("does not overwrite local entities (uses onConflictDoNothing)", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()],
    });

    // Verify onConflictDoNothing was called instead of onConflictDoUpdate
    expect(mockOnConflictDoNothing).toHaveBeenCalled();
  });

  it("different remote nodes with same entity ID get different local IDs", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()],
    });

    // The entity map insert captures the originNodeId, so the unique index
    // (originNodeId, externalEntityId, entityType) ensures that the same
    // remote ID from different nodes gets separate mappings.
    const entityMapInsert = mockValues.mock.calls.find(
      (call) => call[0]?.externalEntityId === REMOTE_AGENT_ID && call[0]?.entityType === "agent"
    );
    expect(entityMapInsert).toBeDefined();
    expect(entityMapInsert![0].originNodeId).toBe(PEER_NODE_ID);
    // localEntityId is a generated UUID, different from the remote ID
    expect(entityMapInsert![0].localEntityId).not.toBe(REMOTE_AGENT_ID);

    // If a second peer with a different peerNodeId imported the same
    // remote entity ID, the resolveLocalEntityId function would not find
    // an existing mapping (different originNodeId) and would generate
    // a fresh UUID — giving a different localEntityId.
  });

  it("sets source attribution in metadata", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()],
    });

    // Find the agent insert and verify metadata contains source attribution
    const agentInsertCalls = mockValues.mock.calls.filter(
      (call) => call[0]?.name === "Remote Agent" && call[0]?.metadata
    );
    expect(agentInsertCalls.length).toBe(1);
    const metadata = agentInsertCalls[0][0].metadata;
    expect(metadata.sourceNodeId).toBe(PEER_NODE_ID);
    expect(metadata.sourceNodeSlug).toBe(PEER_SLUG);
    expect(metadata.externalEntityId).toBe(REMOTE_AGENT_ID);
    // Original metadata fields should be preserved
    expect(metadata.originalField).toBe("kept");
  });

  it("maps resource owner IDs through the entity map", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeResourceEvent()],
    });

    // Should have created entity map entries for the owner and the resource
    const entityMapInserts = mockValues.mock.calls.filter(
      (call) => call[0]?.externalEntityId && call[0]?.entityType
    );

    const ownerMapping = entityMapInserts.find(
      (call) => call[0]?.externalEntityId === REMOTE_OWNER_ID && call[0]?.entityType === "agent"
    );
    const resourceMapping = entityMapInserts.find(
      (call) => call[0]?.externalEntityId === REMOTE_RESOURCE_ID && call[0]?.entityType === "resource"
    );

    expect(ownerMapping).toBeDefined();
    expect(resourceMapping).toBeDefined();
  });

  it("resource import sets source attribution in metadata", async () => {
    setupStandardMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeResourceEvent()],
    });

    const resourceInsertCalls = mockValues.mock.calls.filter(
      (call) => call[0]?.name === "Remote Document" && call[0]?.metadata
    );
    expect(resourceInsertCalls.length).toBe(1);
    const metadata = resourceInsertCalls[0][0].metadata;
    expect(metadata.sourceNodeId).toBe(PEER_NODE_ID);
    expect(metadata.sourceNodeSlug).toBe(PEER_SLUG);
    expect(metadata.externalEntityId).toBe(REMOTE_RESOURCE_ID);
  });
});
