#!/usr/bin/env node
/**
 * Asserts that migration FILES and the Drizzle JOURNAL agree.
 *
 * The migrator discovers migrations through `meta/_journal.json`, never by
 * listing the directory. A committed `.sql` file with no journal entry is
 * therefore invisible: it passes review, passes tests that use an already-
 * migrated database, and simply never runs. This is not hypothetical — global
 * shipped `0060` through `0064` outside the journal, including the tax and
 * withholding tables, and the gap was found only by reading the journal by hand.
 *
 * A journal entry with no file is the mirror failure: the migrator logs a skip
 * and continues, so the schema silently diverges from what the entry claims.
 *
 * Some migrations are deliberately hand-run (backfills that must be supervised,
 * or that are too expensive to run at boot). Those declare it IN the file with
 * a `-- drizzle-journal: manual` header, so the exemption lives next to the SQL
 * it describes rather than in an allowlist here that nobody reads.
 *
 * Exits non-zero with the specific offenders listed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "src",
  "db",
  "migrations",
);
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
const entries = journal.entries ?? [];

const journalTags = entries.map((entry) => entry.tag);
const journalTagSet = new Set(journalTags);
const MANUAL_MARKER = "drizzle-journal: manual";

const allFileTags = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => name.slice(0, -".sql".length))
  .sort();

const manualTags = new Set(
  allFileTags.filter((tag) =>
    readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf-8").includes(MANUAL_MARKER),
  ),
);
const fileTags = allFileTags.filter((tag) => !manualTags.has(tag));

const problems = [];

const unjournaled = fileTags.filter((tag) => !journalTagSet.has(tag));
if (unjournaled.length > 0) {
  problems.push(
    `${unjournaled.length} migration file(s) missing from the journal — these WILL NOT RUN:\n` +
      unjournaled.map((tag) => `  - ${tag}.sql`).join("\n") +
      `\n  Add a journal entry, or declare the file hand-run with a` +
      ` '-- ${MANUAL_MARKER}' header.`,
  );
}

// A hand-run migration that is ALSO journaled would run automatically, which is
// exactly what its marker says must not happen.
const journaledManual = [...manualTags].filter((tag) => journalTagSet.has(tag));
if (journaledManual.length > 0) {
  problems.push(
    `Migration(s) marked hand-run but present in the journal:\n` +
      journaledManual.map((tag) => `  - ${tag}.sql`).join("\n"),
  );
}

const missingFiles = journalTags.filter((tag) => !fileTags.includes(tag));
if (missingFiles.length > 0) {
  problems.push(
    `${missingFiles.length} journal entry/entries with no .sql file — the migrator will skip them:\n` +
      missingFiles.map((tag) => `  - ${tag}`).join("\n"),
  );
}

const duplicateTags = journalTags.filter((tag, index) => journalTags.indexOf(tag) !== index);
if (duplicateTags.length > 0) {
  problems.push(`Duplicate journal tags: ${[...new Set(duplicateTags)].join(", ")}`);
}

// `when` drives the "already applied" comparison, so it must be strictly
// increasing: a backwards value means any database whose last-applied timestamp
// already passed it will silently skip that migration forever.
//
// One inversion predates this check: `0022b` was hand-inserted with a
// synthesized timestamp that leapfrogged `0023`'s original drizzle-generated
// one. Every live database is baselined far beyond both, so rewriting those
// values would carry risk without fixing anything reachable. It is named
// explicitly — by tag, not by index, which renumbers — and reported as a
// warning. Any OTHER inversion fails.
const KNOWN_HISTORICAL_INVERSIONS = new Set([
  "0022b_vector_384_dimensions -> 0023_matrix_integration",
]);
const warnings = [];
for (let i = 1; i < entries.length; i += 1) {
  if (entries[i].when > entries[i - 1].when) continue;
  const pair = `${entries[i - 1].tag} -> ${entries[i].tag}`;
  const message =
    `Journal 'when' is not strictly increasing: ${entries[i - 1].tag} (${entries[i - 1].when}) ` +
    `then ${entries[i].tag} (${entries[i].when})`;
  if (KNOWN_HISTORICAL_INVERSIONS.has(pair)) warnings.push(message);
  else problems.push(message);
}

for (const warning of warnings) console.warn(`WARNING (historical): ${warning}`);

if (problems.length > 0) {
  console.error("Migration journal check FAILED\n");
  for (const problem of problems) console.error(`${problem}\n`);
  process.exit(1);
}

console.log(
  `Migration journal check passed — ${fileTags.length} files, ${entries.length} journal entries, in agreement.`,
);
