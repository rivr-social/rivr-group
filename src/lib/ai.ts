import { pipeline } from "@xenova/transformers";
import { sql, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";

/**
 * AI utilities for embeddings and similarity/geospatial SQL fragments.
 *
 * This module centralizes:
 * - Embedding model configuration and singleton model loading.
 * - Text-to-vector embedding generation (single and batch).
 * - Drizzle SQL helpers for pgvector cosine distance and PostGIS distance/radius checks.
 *
 * Key exports:
 * - `getEmbedder`, `generateEmbedding`, `generateEmbeddings`
 * - `cosineSimilarity`, `withinRadius`, `geoDistance`
 * - `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`
 *
 * Dependencies:
 * - `@xenova/transformers` for local inference pipelines.
 * - `drizzle-orm` SQL fragment construction.
 */

/**
 * Embedding model identifier used for feature extraction.
 * `all-MiniLM-L6-v2` outputs 384-dimensional vectors.
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Fixed dimensionality returned by `EMBEDDING_MODEL`. */
export const EMBEDDING_DIMENSIONS = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedderInstance: any = null;

/**
 * Gets or initializes the singleton embedder pipeline instance.
 *
 * The singleton avoids reloading model weights for each request, which is
 * expensive in both latency and memory.
 *
 * @param _unused - This function does not accept runtime parameters.
 * @returns A ready-to-use transformers feature-extraction pipeline.
 * @throws {Error} If the model pipeline fails to initialize.
 * @example
 * const embedder = await getEmbedder();
 * const vector = await embedder("hello", { pooling: "mean", normalize: true });
 */
export async function getEmbedder() {
  if (embedderInstance === null) {
    // Lazy initialization keeps startup fast and loads the model on first use.
    embedderInstance = await pipeline(
      "feature-extraction",
      EMBEDDING_MODEL
    );
  }
  return embedderInstance;
}

/**
 * Generates a normalized embedding vector for a single text input.
 *
 * @param text - The text to embed
 * @returns Normalized embedding vector as a numeric array (384 dimensions).
 * @throws {Error} If `text` is empty or the embedding model invocation fails.
 * @example
 * const embedding = await generateEmbedding("Community garden planning");
 * console.log(embedding.length); // 384
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const embedder = await getEmbedder();

  const result = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(result.data) as number[];
}

/**
 * Generates normalized embedding vectors for multiple text inputs.
 *
 * More efficient than repeatedly re-initializing the model, because it reuses
 * the singleton embedder instance for the batch loop.
 *
 * @param texts - Array of texts to embed
 * @returns Array of normalized embedding vectors in input order.
 * @throws {Error} If any text is empty or model inference fails.
 * @example
 * const vectors = await generateEmbeddings(["alpha", "beta"]);
 * console.log(vectors.length); // 2
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const embedder = await getEmbedder();

  const results: number[][] = [];
  for (const text of texts) {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot generate embedding for empty text in batch");
    }
    const result = await embedder(text, {
      pooling: "mean",
      normalize: true,
    });
    results.push(Array.from(result.data) as number[]);
  }

  return results;
}

/**
 * Creates a SQL fragment for pgvector cosine distance (`<=>`).
 *
 * Business rule:
 * Lower distance means higher similarity, so callers should sort ascending.
 *
 * @param column - The vector column to compare against
 * @param queryVector - The query embedding vector
 * @returns Drizzle SQL fragment that computes cosine distance for ordering/filtering.
 * @throws {Error} If `queryVector` dimensionality does not match model configuration.
 * @example
 * const orderExpr = cosineSimilarity(resources.embedding, queryEmbedding);
 * // use in ORDER BY orderExpr ASC
 */
export function cosineSimilarity(
  column: SQL,
  queryVector: number[]
): SQL {
  if (queryVector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Query vector has ${queryVector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`
    );
  }
  return sql`${column} <=> ${JSON.stringify(queryVector)}::vector`;
}

/**
 * Creates a SQL fragment for PostGIS radius filtering (`ST_DWithin`).
 *
 * @param column - The geography column to query
 * @param lat - Latitude of the center point
 * @param lng - Longitude of the center point
 * @param radiusMeters - Radius in meters
 * @returns Drizzle SQL fragment for `ST_DWithin`.
 * @throws {Error} Propagates SQL composition/runtime errors from the caller context.
 * @example
 * const whereExpr = withinRadius(resources.geo, 37.78, -122.42, 5000);
 */
export function withinRadius(
  column: SQL,
  lat: number,
  lng: number,
  radiusMeters: number
): SQL {
  // ST_MakePoint uses (longitude, latitude) ordering by PostGIS convention.
  return sql`ST_DWithin(
    ${column},
    ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
    ${radiusMeters}
  )`;
}

/**
 * Creates a SQL fragment for PostGIS geographic distance (`ST_Distance`).
 *
 * Returns distance in meters between a column and a reference point.
 *
 * @param column - The geography column
 * @param lat - Latitude of the reference point
 * @param lng - Longitude of the reference point
 * @returns Drizzle SQL fragment for `ST_Distance` in meters.
 * @throws {Error} Propagates SQL composition/runtime errors from the caller context.
 * @example
 * const distanceExpr = geoDistance(resources.geo, 37.78, -122.42);
 */
export function geoDistance(
  column: SQL,
  lat: number,
  lng: number
): SQL {
  return sql`ST_Distance(
    ${column}::geography,
    ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
  )`;
}

// ---------------------------------------------------------------------------
// Embeddable text composition
// ---------------------------------------------------------------------------

/**
 * Composes a single embeddable string from a name and optional description.
 * Concatenates with a separator so the model captures both identity and context.
 *
 * @param name - The entity name (required, non-empty).
 * @param description - Optional longer description.
 * @returns Composed text suitable for embedding, or null if name is empty.
 */
function composeEmbeddableText(name: string, description?: string | null): string | null {
  const trimmedName = name?.trim();
  if (!trimmedName) return null;
  const trimmedDesc = description?.trim();
  return trimmedDesc ? `${trimmedName}: ${trimmedDesc}` : trimmedName;
}

// ---------------------------------------------------------------------------
// Async embedding update helpers
// ---------------------------------------------------------------------------

/**
 * Generates an embedding for an agent's name + description and stores it.
 * Runs as a fire-and-forget background operation — failures are logged, not thrown.
 *
 * @param agentId - The agent UUID to embed.
 * @param name - Agent name.
 * @param description - Optional agent description/bio.
 */
export async function embedAgent(
  agentId: string,
  name: string,
  description?: string | null
): Promise<void> {
  const text = composeEmbeddableText(name, description);
  if (!text) return;

  try {
    const vector = await generateEmbedding(text);
    await db
      .update(agents)
      .set({ embedding: vector })
      .where(eq(agents.id, agentId));
  } catch (error) {
    console.error(`[embedAgent] Failed for agent ${agentId}:`, error);
  }
}

/**
 * Generates an embedding for a resource's name + description and stores it.
 * Runs as a fire-and-forget background operation — failures are logged, not thrown.
 *
 * @param resourceId - The resource UUID to embed.
 * @param name - Resource name/title.
 * @param description - Optional resource description.
 */
export async function embedResource(
  resourceId: string,
  name: string,
  description?: string | null
): Promise<void> {
  const text = composeEmbeddableText(name, description);
  if (!text) return;

  try {
    const vector = await generateEmbedding(text);
    await db
      .update(resources)
      .set({ embedding: vector })
      .where(eq(resources.id, resourceId));
  } catch (error) {
    console.error(`[embedResource] Failed for resource ${resourceId}:`, error);
  }
}

/**
 * Schedules embedding generation as a fire-and-forget background task.
 * The caller is not blocked — the promise resolves immediately.
 * Errors are caught and logged internally by the embed functions.
 *
 * @param fn - An async embedding function to run in the background.
 */
export function scheduleEmbedding(fn: () => Promise<void>): void {
  fn().catch((error) => {
    console.error("[scheduleEmbedding] Unhandled error:", error);
  });
}
