/**
 * Drizzle Kit config — used to `drizzle-kit push` the schema into a scratch
 * TEST database for `pnpm test:db` (live DBs are migrated via the SQL files
 * in src/db/migrations, NOT via push). Point DATABASE_URL at a disposable
 * database with PostGIS + pgvector installed.
 */
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (point it at a scratch test database)");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
