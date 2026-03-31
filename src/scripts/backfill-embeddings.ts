/**
 * Backfill script: generates embeddings for all agents and resources
 * that have a name but no embedding vector.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-embeddings.ts
 *   npx tsx src/scripts/backfill-embeddings.ts --batch-size 100
 *   npx tsx src/scripts/backfill-embeddings.ts --table agents
 *   npx tsx src/scripts/backfill-embeddings.ts --table resources
 *   npx tsx src/scripts/backfill-embeddings.ts --dry-run
 */

import { sql, eq, isNull, and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { generateEmbedding, getEmbedder } from "@/lib/ai";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function readArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const isDryRun = process.argv.includes("--dry-run");
const tableFilter = readArgValue("--table"); // "agents" | "resources" | null (both)
const batchSize = Number(readArgValue("--batch-size") ?? "50");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function composeEmbeddableText(name: string, description?: string | null): string | null {
  const trimmedName = name?.trim();
  if (!trimmedName) return null;
  const trimmedDesc = description?.trim();
  return trimmedDesc ? `${trimmedName}: ${trimmedDesc}` : trimmedName;
}

// ---------------------------------------------------------------------------
// Backfill logic
// ---------------------------------------------------------------------------

async function backfillAgents(): Promise<{ processed: number; skipped: number; failed: number }> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  // Count total needing backfill
  const [{ count: totalCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agents)
    .where(
      and(
        isNull(agents.embedding),
        isNull(agents.deletedAt),
        isNotNull(agents.name)
      )
    );

  console.log(`[agents] ${totalCount} agents need embeddings`);
  if (totalCount === 0) return { processed, skipped, failed };

  // Process in batches using cursor-based pagination (ordered by createdAt)
  let lastCreatedAt: Date | null = null;
  let lastId: string | null = null;

  while (true) {
    const whereConditions = [
      isNull(agents.embedding),
      isNull(agents.deletedAt),
      isNotNull(agents.name),
    ];

    // Cursor: fetch rows after the last processed row
    const cursorCondition = lastCreatedAt && lastId
      ? sql`(${agents.createdAt}, ${agents.id}) > (${lastCreatedAt}, ${lastId})`
      : undefined;
    if (cursorCondition) whereConditions.push(cursorCondition);

    const batch = await db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(and(...whereConditions))
      .orderBy(agents.createdAt, agents.id)
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const agent of batch) {
      const text = composeEmbeddableText(agent.name, agent.description);
      if (!text) {
        skipped++;
        continue;
      }

      if (isDryRun) {
        console.log(`  [dry-run] would embed agent "${agent.name}" (${agent.id})`);
        processed++;
        continue;
      }

      try {
        const vector = await generateEmbedding(text);
        await db
          .update(agents)
          .set({ embedding: vector })
          .where(eq(agents.id, agent.id));
        processed++;
      } catch (err) {
        console.error(`  [error] agent "${agent.name}" (${agent.id}):`, err);
        failed++;
      }
    }

    const last = batch[batch.length - 1];
    lastCreatedAt = last.createdAt;
    lastId = last.id;

    console.log(`[agents] ${processed + skipped + failed}/${totalCount} processed (${processed} embedded, ${skipped} skipped, ${failed} failed)`);
  }

  return { processed, skipped, failed };
}

async function backfillResources(): Promise<{ processed: number; skipped: number; failed: number }> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  const [{ count: totalCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(resources)
    .where(
      and(
        isNull(resources.embedding),
        isNull(resources.deletedAt),
        isNotNull(resources.name)
      )
    );

  console.log(`[resources] ${totalCount} resources need embeddings`);
  if (totalCount === 0) return { processed, skipped, failed };

  let lastCreatedAt: Date | null = null;
  let lastId: string | null = null;

  while (true) {
    const whereConditions = [
      isNull(resources.embedding),
      isNull(resources.deletedAt),
      isNotNull(resources.name),
    ];

    const cursorCondition = lastCreatedAt && lastId
      ? sql`(${resources.createdAt}, ${resources.id}) > (${lastCreatedAt}, ${lastId})`
      : undefined;
    if (cursorCondition) whereConditions.push(cursorCondition);

    const batch = await db
      .select({
        id: resources.id,
        name: resources.name,
        description: resources.description,
        createdAt: resources.createdAt,
      })
      .from(resources)
      .where(and(...whereConditions))
      .orderBy(resources.createdAt, resources.id)
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const resource of batch) {
      const text = composeEmbeddableText(resource.name, resource.description);
      if (!text) {
        skipped++;
        continue;
      }

      if (isDryRun) {
        console.log(`  [dry-run] would embed resource "${resource.name}" (${resource.id})`);
        processed++;
        continue;
      }

      try {
        const vector = await generateEmbedding(text);
        await db
          .update(resources)
          .set({ embedding: vector })
          .where(eq(resources.id, resource.id));
        processed++;
      } catch (err) {
        console.error(`  [error] resource "${resource.name}" (${resource.id}):`, err);
        failed++;
      }
    }

    const last = batch[batch.length - 1];
    lastCreatedAt = last.createdAt;
    lastId = last.id;

    console.log(`[resources] ${processed + skipped + failed}/${totalCount} processed (${processed} embedded, ${skipped} skipped, ${failed} failed)`);
  }

  return { processed, skipped, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Embedding Backfill ===");
  console.log(`  batch size: ${batchSize}`);
  console.log(`  table filter: ${tableFilter ?? "all"}`);
  console.log(`  dry run: ${isDryRun}`);
  console.log();

  // Pre-warm the embedding model so the first batch isn't slow.
  if (!isDryRun) {
    console.log("[init] Loading embedding model...");
    await getEmbedder();
    console.log("[init] Model ready.\n");
  }

  const stats = { agents: { processed: 0, skipped: 0, failed: 0 }, resources: { processed: 0, skipped: 0, failed: 0 } };

  if (!tableFilter || tableFilter === "agents") {
    stats.agents = await backfillAgents();
    console.log();
  }

  if (!tableFilter || tableFilter === "resources") {
    stats.resources = await backfillResources();
    console.log();
  }

  console.log("=== Backfill Complete ===");
  console.log(`  Agents:    ${stats.agents.processed} embedded, ${stats.agents.skipped} skipped, ${stats.agents.failed} failed`);
  console.log(`  Resources: ${stats.resources.processed} embedded, ${stats.resources.skipped} skipped, ${stats.resources.failed} failed`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
