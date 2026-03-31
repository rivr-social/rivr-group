/**
 * Health check API route.
 *
 * Purpose:
 * Reports service health by checking API responsiveness and database connectivity.
 *
 * Key exports:
 * - `GET`: Returns `ok` when DB is reachable, otherwise `degraded`.
 *
 * Dependencies:
 * - Next.js response helper (`NextResponse`)
 * - Database client (`db`)
 * - Drizzle SQL helper (`sql`)
 * - Shared HTTP status constants
 */
import { NextResponse } from "next/server";
import { STATUS_OK } from "@/lib/http-status";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Returns a health status payload for uptime/readiness monitoring.
 *
 * Operational notes:
 * - No authentication is required so external probes can access this endpoint.
 * - No rate limiting is applied; callers should keep probe frequency reasonable.
 * - Database failures degrade status but do not throw, preserving a structured response.
 *
 * Error handling pattern:
 * - Database check exceptions are caught and converted into a `degraded` health response.
 *
 * @param {Request} _request Incoming request object (not used by this health check).
 * @returns {Promise<NextResponse>} JSON payload with health checks and timestamp.
 * @throws {Error} Propagates unexpected framework-level response serialization failures.
 * @example
 * // GET /api/health
 * // -> 200 { status: "ok", checks: { database: "ok" }, timestamp: "..." }
 */
export async function GET(_request: Request) {
  let database = "ok";
  try {
    // Minimal round-trip query confirms DB connectivity without mutating state.
    await db.execute(sql`SELECT 1`);
  } catch {
    // Downgrade health status rather than failing the endpoint outright.
    database = "error";
  }

  // Surface transport-level degradation when a required dependency is unavailable.
  const status = database === "ok" ? STATUS_OK : 503;

  return NextResponse.json(
    {
      status: database === "ok" ? "ok" : "degraded",
      checks: { database },
      timestamp: new Date().toISOString(),
    },
    { status }
  );
}
