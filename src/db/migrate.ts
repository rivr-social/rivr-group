/**
 * Database migration runner for applying Drizzle SQL migrations.
 *
 * Purpose:
 * - Connects to PostgreSQL using `DATABASE_URL`.
 * - Applies migrations from `src/db/migrations`.
 * - Exits with explicit success/failure codes for CI and deploy scripts.
 *
 * Key exports:
 * - None (script entrypoint only).
 *
 * Dependencies:
 * - `drizzle-orm/postgres-js` and `drizzle-orm/postgres-js/migrator`.
 * - `postgres` driver for direct migration connectivity.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** POSIX-compatible process exit code for successful migration execution. */
const EXIT_SUCCESS = 0;
/** POSIX-compatible process exit code for migration failures or config errors. */
const EXIT_FAILURE = 1;

/**
 * Applies all pending SQL migrations in order and exits the process.
 *
 * @returns Promise that never resolves to a caller because the process exits.
 * @throws {never} Errors are handled internally and converted to process exit codes.
 * @example
 * ```bash
 * DATABASE_URL=postgres://... pnpm tsx src/db/migrate.ts
 * ```
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL environment variable is not set");
    process.exit(EXIT_FAILURE);
  }

  console.log("[migrate] Connecting to database...");

  // Use a dedicated single-connection client so migrations run serially and deterministically.
  const migrationClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    console.log("[migrate] Applying migrations from ./src/db/migrations ...");
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("[migrate] All migrations applied successfully");
  } catch (error) {
    console.error("[migrate] Migration failed:", error instanceof Error ? error.message : error);
    await migrationClient.end();
    process.exit(EXIT_FAILURE);
  }

  await migrationClient.end();
  process.exit(EXIT_SUCCESS);
}

main();
