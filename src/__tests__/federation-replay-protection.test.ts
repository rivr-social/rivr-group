import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * Unit tests for federation event replay protection and idempotency.
 *
 * Verifies that importFederationEvents() properly:
 * - Rejects duplicate nonces (idempotent)
 * - Rejects stale event versions
 * - Rejects events outside the time window
 * - Includes nonce and version in queued export events
 *
 * All database interactions are mocked.
 */

// ---------------------------------------------------------------------------
// Predictable UUIDs
// ---------------------------------------------------------------------------

vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
  return "mocked-uuid-for-test" as ReturnType<typeof crypto.randomUUID>;
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();

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
      nodes: {
        findFirst: (...args: unknown[]) => mockFindFirst("nodes.findFirst", ...args),
        findMany: (...args: unknown[]) => mockFindMany("nodes.findMany", ...args),
      },
      nodePeers: {
        findFirst: (...args: unknown[]) => mockFindFirst("nodePeers.findFirst", ...args),
      },
      federationEntityMap: {
        findFirst: (...args: unknown[]) => mockFindFirst("federationEntityMap.findFirst", ...args),
      },
      federationEvents: {
        findFirst: (...args: unknown[]) => mockFindFirst("federationEvents.findFirst", ...args),
        findMany: (...args: unknown[]) => mockFindMany("federationEvents.findMany", ...args),
      },
      agents: {
        findFirst: (...args: unknown[]) => mockFindFirst("agents.findFirst", ...args),
        findMany: (...args: unknown[]) => mockFindMany("agents.findMany", ...args),
      },
      resources: {
        findMany: (...args: unknown[]) => mockFindMany("resources.findMany", ...args),
      },
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
            returning: (...rArgs: unknown[]) => {
              mockReturning(...rArgs);
              return [{ id: "mock-dead-letter-id" }];
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/lib/federation-crypto", () => ({
  generateNodeKeyPair: vi.fn(),
  signPayload: vi.fn(() => "mock-signature"),
  verifyPayloadSignature: vi.fn(() => true),
}));

import type { VisibilityLevel } from "@/db/schema";

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
  nonce: string;
  eventVersion: number;
  createdAt: string;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    entityType: "agent",
    eventType: "upsert",
    visibility: (overrides.visibility ?? "public") as VisibilityLevel,
    signature: overrides.signature ?? "valid-signature",
    nonce: overrides.nonce,
    eventVersion: overrides.eventVersion,
    createdAt: overrides.createdAt,
    payload: overrides.payload ?? {
      id: "remote-agent-111",
      name: "Remote Agent",
      type: "person",
      description: "An agent from a peer node",
      metadata: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importFederationEvents - replay protection", () => {
  function setupMocks(overrides: {
    nonceExists?: boolean;
    latestVersion?: number | null;
  } = {}) {
    let federationEventsFindFirstCallCount = 0;

    mockFindFirst.mockImplementation((method: string) => {
      if (method === "nodes.findFirst") return makePeerNode();
      if (method === "nodePeers.findFirst") return makeTrustedLink();
      if (method === "federationEntityMap.findFirst") return null;

      if (method === "federationEvents.findFirst") {
        federationEventsFindFirstCallCount++;
        // First call is the nonce check, second is the version check
        if (federationEventsFindFirstCallCount === 1) {
          // Nonce lookup
          if (overrides.nonceExists) {
            return { id: "existing-event-id" };
          }
          return null;
        }
        // Version lookup
        if (overrides.latestVersion != null) {
          return { eventVersion: overrides.latestVersion };
        }
        return null;
      }

      if (method === "agents.findFirst") {
        return { id: "some-agent", name: "Owner", type: "person" };
      }

      return null;
    });
  }

  it("rejects duplicate nonces (idempotent)", async () => {
    setupMocks({ nonceExists: true });

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ nonce: "already-seen-nonce" })],
    });

    expect(result.imported).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toBe("duplicate nonce");
  });

  it("accepts events with unique nonces", async () => {
    setupMocks({ nonceExists: false });

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ nonce: "fresh-nonce-123" })],
    });

    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("rejects events with stale version numbers", async () => {
    setupMocks({ latestVersion: 5 });

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ eventVersion: 3, nonce: "nonce-v3" })],
    });

    expect(result.imported).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toBe("stale version");
  });

  it("rejects events with equal version numbers (must be strictly greater)", async () => {
    setupMocks({ latestVersion: 5 });

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ eventVersion: 5, nonce: "nonce-v5" })],
    });

    expect(result.imported).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toBe("stale version");
  });

  it("accepts events with version greater than current", async () => {
    setupMocks({ latestVersion: 5 });

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ eventVersion: 6, nonce: "nonce-v6" })],
    });

    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("rejects events outside the replay time window", async () => {
    setupMocks();

    const { importFederationEvents } = await loadFederationModule();

    // Create an event from 10 days ago (beyond the 7-day window)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ createdAt: tenDaysAgo, nonce: "old-nonce" })],
    });

    expect(result.imported).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejections[0].reason).toBe("expired");
  });

  it("accepts events within the replay time window", async () => {
    setupMocks();

    const { importFederationEvents } = await loadFederationModule();

    // Create an event from 1 day ago (within the 7-day window)
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ createdAt: oneDayAgo, nonce: "recent-nonce" })],
    });

    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("events without nonce/version/createdAt still pass through (backwards compatible)", async () => {
    setupMocks();

    const { importFederationEvents } = await loadFederationModule();

    const result = await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent()], // No nonce, version, or createdAt
    });

    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("nonce and version are stored in imported events", async () => {
    setupMocks();

    const { importFederationEvents } = await loadFederationModule();

    await importFederationEvents({
      localNodeId: LOCAL_NODE_ID,
      fromPeerSlug: PEER_SLUG,
      events: [makeAgentEvent({ nonce: "my-nonce-123", eventVersion: 7 })],
    });

    // Find the federation_events insert call (not the entity map or agents insert)
    const fedEventInserts = mockValues.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0][0]?.nonce !== undefined
    );
    expect(fedEventInserts.length).toBe(1);
    const insertedEvent = fedEventInserts[0][0][0];
    expect(insertedEvent.nonce).toBe("my-nonce-123");
    expect(insertedEvent.eventVersion).toBe(7);
  });
});
