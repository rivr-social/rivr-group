import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for federation-auth module.
 *
 * We mock the `@/auth` module so we can control session state without
 * needing a real NextAuth setup.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

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
import type { FederationAuthResult, FederationConfigValidation } from "@/lib/federation-auth";

// We need to dynamically import the module under test so process.env changes
// take effect per-test. Vitest caches modules, so we use `vi.resetModules()`
// and re-import.
async function loadModule() {
  const mod = await import("@/lib/federation-auth");
  return mod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://localhost/api/federation/status", {
    headers: new Headers(headers),
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Reset mocks
  vi.mocked(auth).mockReset();
  vi.mocked(db.query.nodes.findFirst).mockReset();
  vi.mocked(db.query.nodePeers.findFirst).mockReset();
});

afterEach(() => {
  // Restore original env
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// authorizeFederationRequest
// ---------------------------------------------------------------------------

describe("authorizeFederationRequest", () => {
  describe("session-based auth", () => {
    it("authorizes a request when a valid session exists for the hosted node owner", async () => {
      vi.mocked(auth).mockResolvedValue({
        user: { id: "user-123", name: "Test User", email: "test@example.com" },
        expires: new Date(Date.now() + 86400000).toISOString(),
      });
      const { db } = await import("@/db");
      vi.mocked(db.query.nodes.findFirst).mockResolvedValue({
        id: "node-1",
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
      const result: FederationAuthResult = await authorizeFederationRequest(makeRequest());

      expect(result.authorized).toBe(true);
      expect(result.actorId).toBe("user-123");
    });

    it("rejects plain session auth when the user does not own the hosted node", async () => {
      vi.mocked(auth).mockResolvedValue({
        user: { id: "user-123", name: "Test User", email: "test@example.com" },
        expires: new Date(Date.now() + 86400000).toISOString(),
      });
      const { db } = await import("@/db");
      vi.mocked(db.query.nodes.findFirst).mockResolvedValue(undefined);
      delete process.env.NODE_ADMIN_KEY;

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(makeRequest());

      expect(result.authorized).toBe(false);
      expect(result.reason).toBe(
        "NODE_ADMIN_KEY is not configured. Set this environment variable to enable federation admin access."
      );
    });

    it("falls through to admin-key check when no session", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      process.env.NODE_ENV = "test";
      process.env.NODE_ADMIN_KEY = "my-secret-key";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "my-secret-key" })
      );

      expect(result.authorized).toBe(true);
      expect(result.actorId).toBeUndefined();
    });
  });

  describe("admin-key auth", () => {
    it("authorizes when request key matches configured NODE_ADMIN_KEY", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      process.env.NODE_ADMIN_KEY = "production-secret-key-42";
      process.env.NODE_ENV = "production";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "production-secret-key-42" })
      );

      expect(result.authorized).toBe(true);
    });

    it("rejects when request key does not match", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      process.env.NODE_ADMIN_KEY = "correct-key";
      process.env.NODE_ENV = "production";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "wrong-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toBe("Authentication required");
    });

    it("rejects when no admin key header is provided", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      process.env.NODE_ADMIN_KEY = "some-key";
      process.env.NODE_ENV = "production";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(makeRequest());

      expect(result.authorized).toBe(false);
      expect(result.reason).toBe("Authentication required");
    });
  });

  describe("missing NODE_ADMIN_KEY in production", () => {
    it("returns unauthorized with clear error when NODE_ADMIN_KEY is unset in production", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      delete process.env.NODE_ADMIN_KEY;
      process.env.NODE_ENV = "production";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "any-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("NODE_ADMIN_KEY is not configured");
    });

    it("returns unauthorized when NODE_ENV is unset and key is missing", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      delete process.env.NODE_ADMIN_KEY;
      delete process.env.NODE_ENV;

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "any-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("NODE_ADMIN_KEY is not configured");
    });
  });

  describe("no dev fallback behavior", () => {
    it("rejects when NODE_ADMIN_KEY is unset in test environment", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      delete process.env.NODE_ADMIN_KEY;
      process.env.NODE_ENV = "test";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "any-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("NODE_ADMIN_KEY is not configured");
    });

    it("rejects when NODE_ADMIN_KEY is unset in development environment", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      delete process.env.NODE_ADMIN_KEY;
      process.env.NODE_ENV = "development";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "any-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("NODE_ADMIN_KEY is not configured");
    });

    it("rejects when NODE_ADMIN_KEY is unset in production", async () => {
      vi.mocked(auth).mockResolvedValue(null);
      delete process.env.NODE_ADMIN_KEY;
      process.env.NODE_ENV = "production";

      const { authorizeFederationRequest } = await loadModule();
      const result = await authorizeFederationRequest(
        makeRequest({ "x-node-admin-key": "any-key" })
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("NODE_ADMIN_KEY is not configured");
    });
  });
});

// ---------------------------------------------------------------------------
// validateFederationConfig
// ---------------------------------------------------------------------------

describe("validateFederationConfig", () => {
  it("returns valid when NODE_ADMIN_KEY is a strong production key", async () => {
    process.env.NODE_ADMIN_KEY = "a-very-strong-production-key-1234";
    process.env.NODE_ENV = "production";

    const { validateFederationConfig } = await loadModule();
    const result: FederationConfigValidation = validateFederationConfig();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when key is missing in production", async () => {
    delete process.env.NODE_ADMIN_KEY;
    process.env.NODE_ENV = "production";

    const { validateFederationConfig } = await loadModule();
    const result = validateFederationConfig();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("NODE_ADMIN_KEY is not set");
  });

  it("returns error when key is missing and NODE_ENV is unset", async () => {
    delete process.env.NODE_ADMIN_KEY;
    delete process.env.NODE_ENV;

    const { validateFederationConfig } = await loadModule();
    const result = validateFederationConfig();

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("NODE_ADMIN_KEY is not set");
  });

  it("returns error when key is missing in development", async () => {
    delete process.env.NODE_ADMIN_KEY;
    process.env.NODE_ENV = "development";

    const { validateFederationConfig } = await loadModule();
    const result = validateFederationConfig();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("NODE_ADMIN_KEY is not set");
  });

  it("warns about short keys", async () => {
    process.env.NODE_ADMIN_KEY = "short";
    process.env.NODE_ENV = "test";

    const { validateFederationConfig } = await loadModule();
    const result = validateFederationConfig();

    expect(result.warnings.some((w) => w.includes("shorter than 16"))).toBe(true);
  });
});
