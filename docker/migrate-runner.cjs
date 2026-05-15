/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Database migration runner for production containers.
 *
 * Plain CommonJS -- runs directly with `node migrate-runner.cjs` in the
 * slim runner stage without tsx or any build tools.
 *
 * Requires:
 *   - DATABASE_URL environment variable
 *   - ./src/db/migrations directory with Drizzle migration files
 */

const { drizzle } = require("drizzle-orm/postgres-js");
const { migrate } = require("drizzle-orm/postgres-js/migrator");
const postgres = require("postgres");

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL environment variable is not set");
    process.exit(EXIT_FAILURE);
  }

  console.log("[migrate] Connecting to database...");

  const migrationClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    console.log("[migrate] Applying migrations from ./src/db/migrations ...");
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("[migrate] All migrations applied successfully");
  } catch (error) {
    console.error("[migrate] Migration failed:", error.message || error);
    await migrationClient.end();
    process.exit(EXIT_FAILURE);
  }

  await migrationClient.end();
  process.exit(EXIT_SUCCESS);
}

main();
