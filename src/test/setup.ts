/**
 * Global test setup — runs once before all test files.
 *
 * Validates the DATABASE_URL, runs Drizzle migrations against the test database,
 * and verifies that PostGIS + pgvector extensions are installed.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "path";
import { readFileSync } from "fs";

/**
 * Loads environment variables from the project-root `.env` file.
 *
 * `globalSetup` runs in an isolated Vitest worker context where dotenv
 * auto-loading may not have occurred, so this function reads the file
 * manually and only sets variables that are not already present in
 * `process.env` (preserving explicit overrides from the shell).
 */
function loadEnvFile() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional
  }
}

/**
 * Vitest global setup hook. Runs once before any test file executes.
 *
 * Responsibilities:
 * 1. Load `.env` to ensure DATABASE_URL is available.
 * 2. Verify database connectivity.
 * 3. Apply all Drizzle migrations to bring the test schema up to date.
 * 4. Confirm PostGIS and pgvector extensions are installed (warns if missing).
 *
 * @throws {Error} If DATABASE_URL is not set or the database is unreachable.
 */
export async function setup() {
  // Load .env — globalSetup runs in a separate context where .env may not be auto-loaded
  loadEnvFile();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
        "Tests require a real Postgres database. " +
        "Set DATABASE_URL in .env or pass it directly."
    );
  }

  console.log("[test-setup] Connecting to database...");

  const migrationClient = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
  });

  try {
    // Verify basic connectivity
    const [connectivity] = await migrationClient`SELECT 1 AS value`;
    if (connectivity?.value !== 1) {
      throw new Error("Database connectivity check failed");
    }
    console.log("[test-setup] Database connection verified");

    // Run Drizzle migrations
    const migrationsPath = path.resolve(
      process.cwd(),
      "src/db/migrations"
    );

    const migrationDb = drizzle(migrationClient);
    await migrate(migrationDb, { migrationsFolder: migrationsPath });
    console.log("[test-setup] Migrations applied successfully");

    // Verify PostGIS + pgvector extensions
    const extensions = await migrationClient`
      SELECT
        COUNT(*) FILTER (WHERE extname = 'postgis') > 0 AS postgis,
        COUNT(*) FILTER (WHERE extname = 'vector') > 0 AS pgvector
      FROM pg_extension
    `;

    const { postgis, pgvector } = extensions[0] as {
      postgis: boolean;
      pgvector: boolean;
    };

    if (!postgis) {
      console.warn(
        "[test-setup] WARNING: PostGIS extension is not installed. " +
          "Spatial queries will fail. Run: CREATE EXTENSION IF NOT EXISTS postgis;"
      );
    }
    if (!pgvector) {
      console.warn(
        "[test-setup] WARNING: pgvector extension is not installed. " +
          "Vector similarity queries will fail. Run: CREATE EXTENSION IF NOT EXISTS vector;"
      );
    }

    if (postgis && pgvector) {
      console.log("[test-setup] PostGIS + pgvector extensions verified");
    }
  } finally {
    await migrationClient.end();
    console.log("[test-setup] Migration connection closed");
  }
}

/**
 * Vitest global teardown hook. Runs once after all test files complete.
 *
 * Currently a no-op because the migration connection is closed inside
 * `setup()`. Retained as a placeholder for future cleanup needs.
 */
export async function teardown() {
  // Nothing to clean up — migration connection is already closed
}
