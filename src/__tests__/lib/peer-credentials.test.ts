import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for per-peer federation credentials: generation, hashing,
 * authentication flow, and the pure utility functions (hashPeerSecret,
 * generatePeerSecret) that do not require database mocks.
 */

// ---------------------------------------------------------------------------
// Mocks — auth is needed because federation-auth imports it at top level
// ---------------------------------------------------------------------------

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// Mock the database module used by authorizePeerSecret
vi.mock("@/db", () => ({
  db: {
    query: {
      nodes: { findFirst: vi.fn() },
      nodePeers: { findFirst: vi.fn() },
    },
  },
}));

import { auth } from "@/auth";
import { db } from "@/db";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.mocked(auth).mockReset();
  // Reset db mocks
  vi.mocked(db.query.nodes.findFirst).mockReset();
  vi.mocked(db.query.nodePeers.findFirst).mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// We need dynamic imports so env changes take effect
async function loadModule() {
  return await import("@/lib/federation-auth");
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://localhost/api/federation/events/import", {
    headers: new Headers(headers),
  });
}

// ---------------------------------------------------------------------------
// hashPeerSecret / generatePeerSecret (pure functions, no DB)
// ---------------------------------------------------------------------------

describe("hashPeerSecret", () => {
  it("returns a hex-encoded SHA-256 hash", async () => {
    const { hashPeerSecret } = await loadModule();
    const hash = hashPeerSecret("test-secret");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output for the same input", async () => {
    const { hashPeerSecret } = await loadModule();

    expect(hashPeerSecret("same-input")).toBe(hashPeerSecret("same-input"));
  });

  it("produces different hashes for different inputs", async () => {
    const { hashPeerSecret } = await loadModule();

    expect(hashPeerSecret("secret-a")).not.toBe(hashPeerSecret("secret-b"));
  });
});

describe("generatePeerSecret", () => {
  it("returns a secret and its hash", async () => {
    const { generatePeerSecret } = await loadModule();
    const { secret, hash } = generatePeerSecret();

    expect(secret).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a base64url-encoded secret of sufficient length", async () => {
    const { generatePeerSecret } = await loadModule();
    const { secret } = generatePeerSecret();

    // 48 bytes → 64 chars in base64url
    expect(secret.length).toBeGreaterThanOrEqual(60);
  });

  it("hash matches the secret when re-hashed", async () => {
    const { generatePeerSecret, hashPeerSecret } = await loadModule();
    const { secret, hash } = generatePeerSecret();

    expect(hashPeerSecret(secret)).toBe(hash);
  });

  it("generates unique secrets on each call", async () => {
    const { generatePeerSecret } = await loadModule();
    const a = generatePeerSecret();
    const b = generatePeerSecret();

    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).not.toBe(b.hash);
  });
});

// ---------------------------------------------------------------------------
// authorizeFederationRequest — per-peer secret auth path
// ---------------------------------------------------------------------------

describe("authorizeFederationRequest — per-peer auth", () => {
  it("authorizes when peer slug and secret match a trusted peer", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest, hashPeerSecret } = await loadModule();
    const secretHash = hashPeerSecret("peer-secret-abc");

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "node-42",
      slug: "remote-locale",
      displayName: "Remote Locale",
      role: "locale",
      baseUrl: "https://remote.example.com",
      publicKey: "pk",
      privateKey: null,
      isHosted: false,
      ownerAgentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(db.query.nodePeers.findFirst).mockResolvedValue({
      id: "peer-link-1",
      localNodeId: "local-node",
      peerNodeId: "node-42",
      trustState: "trusted",
      peerSecretHash: secretHash,
      secretVersion: 1,
      secretRotatedAt: new Date(),
      secretExpiresAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote-locale", "x-peer-secret": "peer-secret-abc" })
    );

    expect(result.authorized).toBe(true);
    expect(result.peerNodeId).toBe("node-42");
  });

  it("rejects when peer slug is unknown", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest } = await loadModule();

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue(undefined);

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "nonexistent", "x-peer-secret": "any" })
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("Unknown peer node");
  });

  it("rejects when peer is not trusted", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest } = await loadModule();

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "node-42",
      slug: "remote-locale",
      displayName: "Remote",
      role: "locale",
      baseUrl: "https://remote.example.com",
      publicKey: "pk",
      privateKey: null,
      isHosted: false,
      ownerAgentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No trusted peer link found
    vi.mocked(db.query.nodePeers.findFirst).mockResolvedValue(undefined);

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote-locale", "x-peer-secret": "any" })
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("Peer is not trusted");
  });

  it("rejects when peer has no credentials configured", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest } = await loadModule();

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "node-42",
      slug: "remote-locale",
      displayName: "Remote",
      role: "locale",
      baseUrl: "https://remote.example.com",
      publicKey: "pk",
      privateKey: null,
      isHosted: false,
      ownerAgentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(db.query.nodePeers.findFirst).mockResolvedValue({
      id: "peer-link-1",
      localNodeId: "local-node",
      peerNodeId: "node-42",
      trustState: "trusted",
      peerSecretHash: null,
      secretVersion: 1,
      secretRotatedAt: null,
      secretExpiresAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote-locale", "x-peer-secret": "any" })
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("no credentials configured");
  });

  it("rejects when peer credentials have expired", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest, hashPeerSecret } = await loadModule();
    const secretHash = hashPeerSecret("peer-secret");

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "node-42",
      slug: "remote-locale",
      displayName: "Remote",
      role: "locale",
      baseUrl: "https://remote.example.com",
      publicKey: "pk",
      privateKey: null,
      isHosted: false,
      ownerAgentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(db.query.nodePeers.findFirst).mockResolvedValue({
      id: "peer-link-1",
      localNodeId: "local-node",
      peerNodeId: "node-42",
      trustState: "trusted",
      peerSecretHash: secretHash,
      secretVersion: 1,
      secretRotatedAt: new Date(),
      secretExpiresAt: new Date(Date.now() - 86400000), // expired yesterday
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote-locale", "x-peer-secret": "peer-secret" })
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("rejects when secret does not match hash", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    delete process.env.NODE_ADMIN_KEY;

    const { authorizeFederationRequest, hashPeerSecret } = await loadModule();

    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "node-42",
      slug: "remote-locale",
      displayName: "Remote",
      role: "locale",
      baseUrl: "https://remote.example.com",
      publicKey: "pk",
      privateKey: null,
      isHosted: false,
      ownerAgentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(db.query.nodePeers.findFirst).mockResolvedValue({
      id: "peer-link-1",
      localNodeId: "local-node",
      peerNodeId: "node-42",
      trustState: "trusted",
      peerSecretHash: hashPeerSecret("correct-secret"),
      secretVersion: 1,
      secretRotatedAt: new Date(),
      secretExpiresAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote-locale", "x-peer-secret": "wrong-secret" })
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("Invalid peer credentials");
  });

  it("prefers session auth over peer credentials", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-123", name: "Admin", email: "admin@example.com" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });
    vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
      id: "local-node-1",
      slug: "local-host",
      displayName: "Local Host",
      role: "global",
      baseUrl: "https://app.example.com",
      publicKey: "pk",
      privateKey: "sk",
      isHosted: true,
      ownerAgentId: "user-123",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { authorizeFederationRequest } = await loadModule();

    // Even with peer headers, session takes precedence
    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote", "x-peer-secret": "something" })
    );

    expect(result.authorized).toBe(true);
    expect(result.actorId).toBe("user-123");
    expect(result.peerNodeId).toBeUndefined();
  });

  it("falls through to admin key when only one peer header is present", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    process.env.NODE_ADMIN_KEY = "admin-key-123";

    const { authorizeFederationRequest } = await loadModule();

    // Only x-peer-slug without x-peer-secret — should skip peer auth
    const result = await authorizeFederationRequest(
      makeRequest({ "x-peer-slug": "remote", "x-node-admin-key": "admin-key-123" })
    );

    expect(result.authorized).toBe(true);
    expect(result.peerNodeId).toBeUndefined();
  });
});
