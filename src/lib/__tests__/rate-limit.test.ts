import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mocks — ensure no Redis connection is attempted
// =============================================================================

// Clear all Redis-related env vars so tests use in-memory fallback
vi.stubEnv("REDIS_URL", "");
vi.stubEnv("REDIS_URL_FILE", "");
vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

const {
  rateLimit,
  checkRateLimit,
  RATE_LIMITS,
  RATE_LIMIT_TIERS,
} = await import("@/lib/rate-limit");

describe("rate-limit (in-memory fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rateLimit (legacy API)", () => {
    it("allows requests under the limit", async () => {
      const key = `test:${Date.now()}:${Math.random()}`;
      const result = await rateLimit(key, 5, 60_000);

      expect(result.success).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.resetMs).toBeGreaterThan(0);
    });

    it("blocks requests over the limit", async () => {
      const key = `test:block:${Date.now()}:${Math.random()}`;
      const limit = 3;
      const windowMs = 60_000;

      // Exhaust the limit
      for (let i = 0; i < limit; i++) {
        const result = await rateLimit(key, limit, windowMs);
        expect(result.success).toBe(true);
      }

      // Next request should be blocked
      const blocked = await rateLimit(key, limit, windowMs);
      expect(blocked.success).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetMs).toBeGreaterThan(0);
    });

    it("reports correct remaining count", async () => {
      const key = `test:remaining:${Date.now()}:${Math.random()}`;
      const limit = 5;

      const r1 = await rateLimit(key, limit, 60_000);
      expect(r1.remaining).toBe(4);

      const r2 = await rateLimit(key, limit, 60_000);
      expect(r2.remaining).toBe(3);

      const r3 = await rateLimit(key, limit, 60_000);
      expect(r3.remaining).toBe(2);
    });
  });

  describe("checkRateLimit (tier-based API)", () => {
    it("allows requests for AUTH tier", async () => {
      const identifier = `user:${Date.now()}:${Math.random()}`;
      const result = await checkRateLimit("AUTH", identifier);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
      expect(result.resetAt).toBeInstanceOf(Date);
      expect(result.retryAfterMs).toBe(0);
    });

    it("allows requests for FEDERATION tier", async () => {
      const identifier = `peer:${Date.now()}:${Math.random()}`;
      const result = await checkRateLimit("FEDERATION", identifier);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it("blocks after exceeding WALLET tier limit", async () => {
      const identifier = `wallet:${Date.now()}:${Math.random()}`;
      const tier = RATE_LIMIT_TIERS.WALLET;

      // Exhaust the limit
      for (let i = 0; i < tier.maxRequests; i++) {
        await checkRateLimit("WALLET", identifier);
      }

      const blocked = await checkRateLimit("WALLET", identifier);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("RATE_LIMITS presets", () => {
    it("defines expected preset keys", () => {
      expect(RATE_LIMITS).toHaveProperty("AUTH");
      expect(RATE_LIMITS).toHaveProperty("SOCIAL");
      expect(RATE_LIMITS).toHaveProperty("SETTINGS");
      expect(RATE_LIMITS).toHaveProperty("WALLET");
      expect(RATE_LIMITS).toHaveProperty("PASSWORD_RESET");
    });

    it("has positive limit and window values for all presets", () => {
      for (const [key, preset] of Object.entries(RATE_LIMITS)) {
        expect(preset.limit, `${key}.limit`).toBeGreaterThan(0);
        expect(preset.windowMs, `${key}.windowMs`).toBeGreaterThan(0);
      }
    });
  });

  describe("RATE_LIMIT_TIERS", () => {
    it("defines expected tier keys", () => {
      expect(RATE_LIMIT_TIERS).toHaveProperty("AUTH");
      expect(RATE_LIMIT_TIERS).toHaveProperty("AUTH_SIGNUP");
      expect(RATE_LIMIT_TIERS).toHaveProperty("FEDERATION");
      expect(RATE_LIMIT_TIERS).toHaveProperty("WALLET");
      expect(RATE_LIMIT_TIERS).toHaveProperty("API");
    });

    it("all tiers have prefix, windowMs, and maxRequests", () => {
      for (const [key, tier] of Object.entries(RATE_LIMIT_TIERS)) {
        expect(tier.prefix, `${key}.prefix`).toBeTruthy();
        expect(tier.windowMs, `${key}.windowMs`).toBeGreaterThan(0);
        expect(tier.maxRequests, `${key}.maxRequests`).toBeGreaterThan(0);
      }
    });
  });
});
