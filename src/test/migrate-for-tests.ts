/**
 * Test-compatible migration runner that commits between migration files.
 *
 * Drizzle's built-in migrate() wraps ALL migrations in a single
 * transaction. This breaks Postgres ALTER TYPE ... ADD VALUE because
 * new enum values aren't usable until the transaction commits. On
 * existing databases this isn't an issue (the enum values were added in
 * previous deploys), but on a fresh CI database it fails.
 *
 * This runner reads the Drizzle journal, runs each migration in its own
 * auto-committed statement, and records it in the drizzle migrations
 * table — matching the same behavior as Drizzle's migrate() but without
 * the all-in-one-transaction wrapper.
 */

import postgres from "postgres";
import { readFileSync } from "fs";
import path from "path";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export async function migrateForTests(databaseUrl: string): Promise<void> {
  const migrationsFolder = path.resolve(
    process.cwd(),
    "src/db/migrations",
  );

  // Read journal
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal: Journal = JSON.parse(readFileSync(journalPath, "utf-8"));

  // Use a single connection with auto-commit (no explicit transaction)
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Create migrations tracking schema and table
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;

    // Get last applied migration
    const applied = await sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const lastApplied = applied[0]?.created_at
      ? Number(applied[0].created_at)
      : 0;

    // Apply each pending migration in its own implicit transaction
    for (const entry of journal.entries) {
      if (entry.when <= lastApplied) continue;

      const filePath = path.join(migrationsFolder, `${entry.tag}.sql`);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        console.warn(
          `[migrate-for-tests] Skipping missing file: ${entry.tag}.sql`,
        );
        continue;
      }

      // Split on Drizzle's statement-breakpoint marker
      const statements = content
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }

      // Compute hash to match Drizzle's expectations
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
    }
  } finally {
    await sql.end();
  }
}
