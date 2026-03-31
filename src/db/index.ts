/**
 * Database runtime module for creating and managing the shared Drizzle client.
 *
 * Purpose:
 * - Initializes the postgres.js pool used by the application.
 * - Applies a defensive parameter sanitization layer for Date bindings.
 * - Exposes health and lifecycle helpers for connection management.
 *
 * Key exports:
 * - `db`: Drizzle ORM instance bound to the full database schema.
 * - `closeDatabase()`: graceful connection teardown utility.
 * - `testConnection()`: lightweight connectivity probe.
 * - `healthCheck()`: runtime status snapshot including extension availability.
 *
 * Dependencies:
 * - `drizzle-orm/postgres-js` for ORM integration.
 * - `postgres` for the underlying PostgreSQL client/pool.
 * - `@/lib/env` for environment configuration lookup.
 * - `./schema` for typed table and relation definitions.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import * as schema from './schema';

type QueryClient = ReturnType<typeof postgres>;

const buildFallbackDatabaseUrl = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const databaseUrlFromSecret = process.env.DATABASE_URL_FILE
  ? readFileSync(process.env.DATABASE_URL_FILE, 'utf-8').trim()
  : '';
const connectionString =
  process.env.DATABASE_URL ||
  databaseUrlFromSecret ||
  buildFallbackDatabaseUrl;

if (!process.env.DATABASE_URL && !databaseUrlFromSecret) {
  console.warn(
    'DATABASE_URL is not set. Using placeholder DSN for build-time module initialization.'
  );
}

// Create postgres client for queries
const rawClient = postgres(connectionString, {
  max: 10, // Maximum number of connections in the pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout in seconds
  prepare: false, // Disabled: prepared statements cause Date binding errors with Drizzle + postgres.js
});

/**
 * Sanitize query parameters to convert Date objects to ISO strings.
 * Fixes Drizzle ORM + postgres.js incompatibility where Date objects
 * in bind parameters crash the postgres wire protocol's Bind function.
 * This is intentionally narrow: only `Date` objects are transformed and all
 * other parameter types are passed through unchanged.
 */
function sanitizeParams(params: unknown[]): unknown[] {
  return params.map(p => p instanceof Date ? p.toISOString() : p);
}

// Patch `unsafe()` which Drizzle calls for all queries.
// Security note: queries still use parameterized bindings; this patch only normalizes values.
const origUnsafe = rawClient.unsafe as (
  query: string,
  params?: unknown[],
  options?: Record<string, unknown>
) => unknown;
Object.defineProperty(rawClient, 'unsafe', {
  value(query: string, params?: unknown[], options?: Record<string, unknown>) {
    const safeParams = params ? sanitizeParams(params) : [];
    return origUnsafe.call(rawClient, query, safeParams, options ?? {});
  },
  writable: true,
  configurable: true,
});

const queryClient: QueryClient = rawClient;

/**
 * Drizzle ORM instance with full schema
 * Use this for all database operations
 */
export const db = drizzle(queryClient, { schema });

/**
 * Type-safe database instance with schema
 */
export type Database = typeof db;

/**
 * Re-export schema for convenience
 */
export * from './schema';

/**
 * Graceful shutdown handler
 * Closes database connections when the application exits
 *
 * @returns Promise that resolves when the underlying postgres client has closed.
 * @throws {Error} Propagates client shutdown errors from `postgres.js`.
 * @example
 * ```ts
 * await closeDatabase();
 * ```
 */
export async function closeDatabase(): Promise<void> {
  await queryClient.end();
}

/**
 * Test database connection
 *
 * @returns `true` when the query returns the expected sentinel value; otherwise `false`.
 * @throws {never} This function catches all runtime errors and returns `false`.
 * @example
 * ```ts
 * const connected = await testConnection();
 * if (!connected) {
 *   console.error('Database is unavailable');
 * }
 * ```
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await queryClient`SELECT 1 as value`;
    return result[0]?.value === 1;
  } catch (error) {
    console.error('Database connection test failed:', error);
    return false;
  }
}

/**
 * Database health check
 *
 * @returns Health payload including connectivity and required extension checks.
 * @throws {never} This function catches all runtime errors and returns an unhealthy result.
 * @example
 * ```ts
 * const health = await healthCheck();
 * if (health.status !== 'healthy') {
 *   console.error(health.error);
 * }
 * ```
 */
export async function healthCheck(): Promise<{
  status: 'healthy' | 'unhealthy';
  connected: boolean;
  extensions: {
    postgis: boolean;
    pgvector: boolean;
  };
  error?: string;
}> {
  try {
    // Test basic connection
    const connected = await testConnection();
    if (!connected) {
      return {
        status: 'unhealthy',
        connected: false,
        extensions: { postgis: false, pgvector: false },
        error: 'Failed to connect to database',
      };
    }

    // Check required extensions explicitly so startup diagnostics include extension drift.
    const extensionsResult = await queryClient`
      SELECT
        COUNT(*) FILTER (WHERE extname = 'postgis') > 0 as postgis,
        COUNT(*) FILTER (WHERE extname = 'vector') > 0 as pgvector
      FROM pg_extension
    `;

    const extensions = extensionsResult[0] as { postgis: boolean; pgvector: boolean };

    const allExtensionsPresent = extensions.postgis && extensions.pgvector;

    return {
      status: allExtensionsPresent ? 'healthy' : 'unhealthy',
      connected: true,
      extensions,
      error: allExtensionsPresent
        ? undefined
        : 'Required extensions (postgis, pgvector) are not installed',
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      connected: false,
      extensions: { postgis: false, pgvector: false },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Handle graceful shutdown
if (typeof process !== 'undefined') {
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing database connections...');
    await closeDatabase();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing database connections...');
    await closeDatabase();
    process.exit(0);
  });
}
