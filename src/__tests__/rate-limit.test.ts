import { describe, it, expect, beforeEach, vi } from "vitest";

// The in-memory store is module-level, so we need to isolate between tests.
// We'll dynamically import the module after resetting module registry each time.
let rateLimit: typeof import("@/lib/rate-limit").rateLimit;
let RATE_LIMITS: typeof import("@/lib/rate-limit").RATE_LIMITS;

beforeEach(async () => {
  vi.resetModules();
  // Clear Upstash env so the in-memory path is always used
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const mod = await import("@/lib/rate-limit");
  rateLimit = mod.rateLimit;
  RATE_LIMITS = mod.RATE_LIMITS;
});

describe("rateLimit", () => {
  it("allows requests within the configured limit", async () => {
    const LIMIT = 5;
    const WINDOW_MS = 60_000;

    for (let i = 0; i < LIMIT; i++) {
      const result = await rateLimit("test-allow", LIMIT, WINDOW_MS);
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(LIMIT - (i + 1));
    }
  });

  it("blocks requests that exceed the limit", async () => {
    const LIMIT = 3;
    const WINDOW_MS = 60_000;

    // Exhaust the limit
    for (let i = 0; i < LIMIT; i++) {
      const result = await rateLimit("test-block", LIMIT, WINDOW_MS);
      expect(result.success).toBe(true);
    }

    // Next request should be blocked
    const blocked = await rateLimit("test-block", LIMIT, WINDOW_MS);
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetMs).toBeGreaterThan(0);
  });

  it("resets after the window expires (sliding window)", async () => {
    const LIMIT = 2;
    const WINDOW_MS = 100; // 100ms window for fast test

    // Exhaust limit
    await rateLimit("test-expire", LIMIT, WINDOW_MS);
    await rateLimit("test-expire", LIMIT, WINDOW_MS);

    const blocked = await rateLimit("test-expire", LIMIT, WINDOW_MS);
    expect(blocked.success).toBe(false);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 50));

    // Should be allowed again
    const allowed = await rateLimit("test-expire", LIMIT, WINDOW_MS);
    expect(allowed.success).toBe(true);
    expect(allowed.remaining).toBe(LIMIT - 1);
  });

  it("tracks different keys independently", async () => {
    const LIMIT = 2;
    const WINDOW_MS = 60_000;

    // Exhaust key-a
    await rateLimit("key-a", LIMIT, WINDOW_MS);
    await rateLimit("key-a", LIMIT, WINDOW_MS);
    const blockedA = await rateLimit("key-a", LIMIT, WINDOW_MS);
    expect(blockedA.success).toBe(false);

    // key-b should still be allowed
    const allowedB = await rateLimit("key-b", LIMIT, WINDOW_MS);
    expect(allowedB.success).toBe(true);
    expect(allowedB.remaining).toBe(LIMIT - 1);
  });

  it("decrements remaining count correctly on each request", async () => {
    const LIMIT = 5;
    const WINDOW_MS = 60_000;

    const r1 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r1.remaining).toBe(4);

    const r2 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r2.remaining).toBe(3);

    const r3 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r3.remaining).toBe(2);

    const r4 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r4.remaining).toBe(1);

    const r5 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r5.remaining).toBe(0);

    // Exceeding the limit
    const r6 = await rateLimit("test-remaining", LIMIT, WINDOW_MS);
    expect(r6.success).toBe(false);
    expect(r6.remaining).toBe(0);
  });
});

describe("RATE_LIMITS presets", () => {
  it("exports expected preset keys with valid limit and windowMs", () => {
    const expectedKeys = ["AUTH", "SOCIAL", "SETTINGS", "FEDERATION_IMPORT", "GROUP_ACCESS"] as const;

    for (const key of expectedKeys) {
      expect(RATE_LIMITS[key]).toBeDefined();
      expect(RATE_LIMITS[key].limit).toBeGreaterThan(0);
      expect(RATE_LIMITS[key].windowMs).toBeGreaterThan(0);
    }
  });
});
