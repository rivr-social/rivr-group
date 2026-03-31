/**
 * Rate limiter with Redis-backed sliding window (ioredis) and in-memory fallback.
 *
 * Key exports:
 * - `rateLimit`: legacy entry point (key, limit, windowMs) — backward compatible.
 * - `checkRateLimit`: tier-based entry point for new code paths.
 * - `RATE_LIMITS`: preconfigured policy presets by feature area.
 * - `RATE_LIMIT_TIERS`: tier definitions for `checkRateLimit`.
 * - `closeRateLimitConnection`: graceful shutdown for the Redis connection.
 *
 * Dependencies:
 * - `ioredis` for Redis sorted-set sliding window when `REDIS_URL` is set.
 * - Falls back to Upstash REST API when `UPSTASH_REDIS_REST_URL/TOKEN` are set.
 * - Falls back to in-memory `Map` when neither Redis backend is available.
 */

import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Tier-based rate limit configuration
// ---------------------------------------------------------------------------

/** Rate limit tiers for use with `checkRateLimit`. */
export const RATE_LIMIT_TIERS = {
  AUTH: { windowMs: 15 * 60 * 1000, maxRequests: 5, prefix: "rl:auth" },
  AUTH_SIGNUP: { windowMs: 60 * 60 * 1000, maxRequests: 3, prefix: "rl:signup" },
  FEDERATION: { windowMs: 60 * 1000, maxRequests: 100, prefix: "rl:federation" },
  WALLET: { windowMs: 60 * 1000, maxRequests: 20, prefix: "rl:wallet" },
  API: { windowMs: 60 * 1000, maxRequests: 60, prefix: "rl:api" },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** Result from the legacy `rateLimit` function. */
export interface RateLimitResult {
  /** Whether the request is allowed under the configured limit. */
  success: boolean;
  /** Remaining number of allowed requests in the current window. */
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

/** Result from the tier-based `checkRateLimit` function. */
export interface TierRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
}

// ---------------------------------------------------------------------------
// Redis connection (ioredis)
// ---------------------------------------------------------------------------

let redisClient: Redis | null = null;

function getRedisUrl(): string | undefined {
  // Support Docker secret-file pattern: REDIS_URL_FILE points to a mounted file.
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (process.env.REDIS_URL_FILE) {
    try {
      const { readFileSync } = require("fs");
      return (readFileSync(process.env.REDIS_URL_FILE, "utf-8") as string).trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getRedisClient(): Redis | null {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;

  if (!redisClient) {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redisClient.on("error", (err) => {
      console.warn("[rate-limit] Redis connection error:", err.message);
    });
  }

  return redisClient;
}

// ---------------------------------------------------------------------------
// Redis sliding window (sorted sets)
// ---------------------------------------------------------------------------

async function redisSlidingWindow(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  try {
    const pipeline = redis.pipeline();

    // Remove expired entries outside the sliding window.
    pipeline.zremrangebyscore(key, 0, windowStart);
    // Count entries remaining in the window.
    pipeline.zcard(key);
    // Tentatively add the current request.
    pipeline.zadd(key, now.toString(), member);
    // Ensure the key expires when the window closes (avoids orphan keys).
    pipeline.pexpire(key, windowMs);

    const results = await pipeline.exec();

    if (!results) {
      // Pipeline failure — degrade to fallback.
      return null;
    }

    const currentCount = (results[1]?.[1] as number) || 0;

    if (currentCount >= limit) {
      // Over limit — remove the entry we just added.
      await redis.zrem(key, member);

      // Find when the oldest entry will expire to calculate retry time.
      const earliest = await redis.zrange(key, 0, 0, "WITHSCORES");
      const resetMs =
        earliest.length >= 2
          ? parseInt(earliest[1]) + windowMs - now
          : windowMs;

      return { success: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    return {
      success: true,
      remaining: Math.max(0, limit - currentCount - 1),
      resetMs: windowMs,
    };
  } catch {
    // Redis failure — degrade gracefully.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upstash REST fallback (preserved for deployments already using Upstash)
// ---------------------------------------------------------------------------

async function postUpstashCommand<T>(
  command: (string | number)[]
): Promise<T | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return null;

  try {
    const response = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([command]),
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as Array<{ result?: unknown }>;
    return (payload?.[0]?.result as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function upstashRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult | null> {
  const count = await postUpstashCommand<number>(["INCR", key]);
  if (typeof count !== "number") return null;

  if (count === 1) {
    await postUpstashCommand<number>(["PEXPIRE", key, windowMs]);
  }

  const ttlMs = await postUpstashCommand<number>(["PTTL", key]);
  const resetMs = typeof ttlMs === "number" && ttlMs >= 0 ? ttlMs : windowMs;

  if (count > limit) {
    return { success: false, remaining: 0, resetMs };
  }

  return {
    success: true,
    remaining: Math.max(0, limit - count),
    resetMs,
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

interface MemoryEntry {
  count: number;
  resetAt: number;
}

/** Process-local fallback store used when no Redis backend is available. */
const memoryStore = new Map<string, MemoryEntry>();

/** Frequency for purging expired entries from the in-memory fallback store. */
const CLEANUP_INTERVAL_MS = 60_000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.resetAt <= now) {
      memoryStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

if (typeof cleanupInterval === "object" && "unref" in cleanupInterval) {
  cleanupInterval.unref();
}

function inMemoryRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.resetAt <= now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, resetMs: windowMs };
  }

  entry.count += 1;
  const resetMs = entry.resetAt - now;

  if (entry.count > limit) {
    return { success: false, remaining: 0, resetMs };
  }

  return {
    success: true,
    remaining: Math.max(0, limit - entry.count),
    resetMs,
  };
}

// ---------------------------------------------------------------------------
// Public API — legacy (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Applies rate limiting for a key using Redis sliding window when available,
 * then Upstash REST, then in-memory fallback.
 *
 * @param key - Unique identifier for the caller/resource being limited.
 * @param limit - Maximum allowed requests per window.
 * @param windowMs - Duration of the limit window in milliseconds.
 * @returns Decision object indicating allow/deny, remaining quota, and reset time.
 * @example
 * ```ts
 * const result = await rateLimit(`auth:${ip}`, 5, 15 * 60 * 1000);
 * if (!result.success) {
 *   throw new Error(`Too many requests. Retry in ${result.resetMs}ms.`);
 * }
 * ```
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  // 1. Try ioredis sliding window first.
  const redisResult = await redisSlidingWindow(key, limit, windowMs);
  if (redisResult) return redisResult;

  // 2. Try Upstash REST API.
  const upstashResult = await upstashRateLimit(key, limit, windowMs);
  if (upstashResult) return upstashResult;

  // 3. In-memory fallback.
  return inMemoryRateLimit(key, limit, windowMs);
}

// ---------------------------------------------------------------------------
// Public API — tier-based
// ---------------------------------------------------------------------------

/**
 * Sliding window rate limiter using tier-based configuration.
 * Preferred for new code paths (federation, wallet, general API).
 *
 * @param tier - One of the predefined `RATE_LIMIT_TIERS` keys.
 * @param identifier - Caller identifier (IP, user ID, peer slug, etc.).
 * @returns Detailed result with allowed state, remaining quota, and retry info.
 * @example
 * ```ts
 * const result = await checkRateLimit("FEDERATION", peerSlug);
 * if (!result.allowed) {
 *   return new Response("Too many requests", { status: 429 });
 * }
 * ```
 */
export async function checkRateLimit(
  tier: RateLimitTier,
  identifier: string
): Promise<TierRateLimitResult> {
  const config = RATE_LIMIT_TIERS[tier];
  const key = `${config.prefix}:${identifier}`;
  const now = Date.now();

  const result = await rateLimit(key, config.maxRequests, config.windowMs);

  return {
    allowed: result.success,
    remaining: result.remaining,
    resetAt: new Date(now + result.resetMs),
    retryAfterMs: result.success ? 0 : result.resetMs,
  };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully close the Redis connection used by the rate limiter.
 */
export async function closeRateLimitConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// ---------------------------------------------------------------------------
// Pre-configured presets (backward compatible)
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV !== "production";

/**
 * Shared rate-limit policy catalog used by API/domain features.
 *
 * Pattern:
 * - `limit`: max requests within a rolling/fixed window.
 * - `windowMs`: window size in milliseconds.
 * - Values are looser in non-production environments.
 */
export const RATE_LIMITS = {
  AUTH: { limit: isDev ? 100 : 5, windowMs: isDev ? 60_000 : 15 * 60 * 1000 },
  SOCIAL: { limit: isDev ? 500 : 60, windowMs: 60 * 1000 },
  SETTINGS: { limit: isDev ? 100 : 10, windowMs: 60 * 1000 },
  FEDERATION_IMPORT: { limit: isDev ? 1000 : 100, windowMs: 60 * 1000 },
  LOCATIONS: { limit: isDev ? 300 : 30, windowMs: 60 * 1000 },
  GROUP_ACCESS: { limit: isDev ? 100 : 5, windowMs: isDev ? 60_000 : 15 * 60 * 1000 },
  EMAIL: { limit: isDev ? 100 : 3, windowMs: isDev ? 60_000 : 60 * 60 * 1000 },
  EMAIL_BROADCAST: { limit: isDev ? 50 : 2, windowMs: isDev ? 60_000 : 60 * 60 * 1000 },
  PASSWORD_RESET: { limit: isDev ? 50 : 3, windowMs: isDev ? 60_000 : 15 * 60 * 1000 },
  WALLET: { limit: isDev ? 100 : 10, windowMs: 60 * 1000 },
  WALLET_DEPOSIT: { limit: isDev ? 50 : 5, windowMs: 60 * 1000 },
} as const;
