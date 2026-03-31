/**
 * Test database instance + transaction isolation.
 *
 * Provides a real Drizzle instance connected to the test database, and
 * `withTestTransaction(fn)` which wraps each test in a transaction that
 * always rolls back — giving perfect isolation without data cleanup.
 *
 * Usage in test files:
 *
 *   vi.mock('@/db', async () => {
 *     const { getTestDbModule } = await import('@/test/db');
 *     return getTestDbModule();
 *   });
 *
 *   import { withTestTransaction } from '@/test/db';
 *
 *   it('does something', () => withTestTransaction(async (db) => {
 *     // db is a real Drizzle instance inside a transaction
 *     // everything rolls back after the callback finishes
 *   }));
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

// ---------------------------------------------------------------------------
// Shared postgres client for all tests in this process
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for database tests");
}

const rawClient = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// ---------------------------------------------------------------------------
// Date sanitization — mirrors src/db/index.ts monkey-patch
// ---------------------------------------------------------------------------

/**
 * Converts Date instances in a parameter array to ISO-8601 strings.
 *
 * postgres.js may mis-handle Date objects in unsafe queries depending on
 * the driver version; converting to ISO strings avoids timezone ambiguity
 * and serialization inconsistencies.
 *
 * @param params - Query parameters, potentially containing Date instances.
 * @returns A new array with Date values replaced by their ISO string representation.
 */
function sanitizeParams(params: unknown[]): unknown[] {
  return params.map((p) => (p instanceof Date ? p.toISOString() : p));
}

/**
 * Monkey-patches the `.unsafe()` method on a postgres.js client to sanitize
 * Date parameters before execution. This mirrors the same patch applied in
 * the production `src/db/index.ts` module.
 *
 * @param client - A postgres.js SQL client instance.
 */
function patchUnsafe(client: postgres.Sql) {
  const origUnsafe = client.unsafe as (
    query: string,
    params?: unknown[],
    options?: Record<string, unknown>
  ) => unknown;

  Object.defineProperty(client, 'unsafe', {
    value(query: string, params?: unknown[], options?: Record<string, unknown>) {
      const safeParams = params ? sanitizeParams(params) : [];
      return origUnsafe.call(client, query, safeParams, options ?? {});
    },
    writable: true,
    configurable: true,
  });
}

// Patch the shared client
patchUnsafe(rawClient);

// ---------------------------------------------------------------------------
// Shared Drizzle instance (used outside transactions)
// ---------------------------------------------------------------------------

export const testDb = drizzle(rawClient, { schema });

export type TestDatabase = typeof testDb;

// ---------------------------------------------------------------------------
// Mutable reference — getCurrentDb() returns the transaction-scoped db
// ---------------------------------------------------------------------------

let _currentDb: TestDatabase = testDb;

/**
 * Returns the currently active test database instance.
 *
 * During a `withTestTransaction` call this returns the transaction-scoped
 * Drizzle instance; outside of one it falls back to the shared `testDb`.
 *
 * @returns The active Drizzle database instance for the current test scope.
 */
export function getCurrentDb(): TestDatabase {
  return _currentDb;
}

/**
 * Replaces the currently active test database instance.
 *
 * Typically only called by `withTestTransaction` to swap in the
 * transaction-scoped instance and restore the previous one on cleanup.
 *
 * @param db - The Drizzle instance to install as the current database.
 */
export function setCurrentDb(db: TestDatabase): void {
  _currentDb = db;
}

// ---------------------------------------------------------------------------
// Savepoint support for reserved connections
// ---------------------------------------------------------------------------

/**
 * Global counter for generating unique savepoint names across all
 * test transactions within this process.
 */
let _savepointCounter = 0;

/**
 * Adds `.begin()` and `.savepoint()` methods to a reserved connection so that
 * Drizzle's `db.transaction()` works inside `withTestTransaction`.
 *
 * postgres.js `reserve()` returns a minimal tagged-template function without
 * `.begin()`. Drizzle's PostgresJsSession calls `this.client.begin(callback)`
 * to start a transaction, and within a transaction it calls
 * `this.client.savepoint(callback)` for nested transactions.
 *
 * Since we already have an outer BEGIN from `withTestTransaction`, both
 * `.begin()` and `.savepoint()` are implemented using SAVEPOINTs.
 */
function addSavepointSupport(
  conn: ReturnType<postgres.Sql["reserve"]> extends Promise<infer R>
    ? R
    : never
): void {
  const client = conn as unknown as Record<string, unknown>;

  /**
   * Implements a savepoint-based pseudo-transaction. Both `.begin()` and
   * `.savepoint()` use this same logic: create a SAVEPOINT, run the
   * callback, RELEASE on success or ROLLBACK TO on failure.
   *
   * The callback receives the same connection object (with .begin/.savepoint
   * still attached) so that further nesting continues to work.
   */
  const unsafeFn = client.unsafe as (query: string) => Promise<unknown>;

  async function executeSavepoint<T>(
    callback: (innerClient: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    const id = ++_savepointCounter;
    const name = `sp_test_${id}`;

    await unsafeFn(`SAVEPOINT ${name}`);

    try {
      const result = await callback(client);
      await unsafeFn(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await unsafeFn(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  // Drizzle's PostgresJsSession.transaction() calls client.begin(callback)
  client.begin = <T>(
    callback: (innerClient: Record<string, unknown>) => Promise<T>
  ): Promise<T> => executeSavepoint(callback);

  // Drizzle's PostgresJsTransaction.transaction() calls client.savepoint(callback)
  client.savepoint = <T>(
    callback: (innerClient: Record<string, unknown>) => Promise<T>
  ): Promise<T> => executeSavepoint(callback);
}

// ---------------------------------------------------------------------------
// withTestTransaction — wraps a test callback in BEGIN … ROLLBACK
// ---------------------------------------------------------------------------

/**
 * Wraps a test function in a database transaction that always rolls back.
 *
 * - Reserves a dedicated connection from the pool
 * - Issues BEGIN, runs the test, issues ROLLBACK
 * - Nested `db.transaction()` calls become SAVEPOINTs automatically
 * - Sets the current db so that mocked `@/db` returns the tx-scoped instance
 */
export async function withTestTransaction<T>(
  fn: (db: TestDatabase) => Promise<T>
): Promise<T> {
  // Reserve a dedicated connection so the transaction lives on a single conn
  const reserved = await rawClient.reserve();

  try {
    // Patch the reserved connection's unsafe() for Date handling
    patchUnsafe(reserved as unknown as postgres.Sql);

    // Add .begin() and .savepoint() so Drizzle's db.transaction() works
    addSavepointSupport(reserved);

    await reserved`BEGIN`;

    // Forward `options` from the parent client so drizzle can read `parsers`.
    // postgres.js `reserve()` returns a minimal tagged-template function that
    // doesn't carry the full client shape drizzle-orm expects.
    const reservedAsSql = reserved as unknown as postgres.Sql;
    if (!("options" in reservedAsSql) && "options" in rawClient) {
      (reservedAsSql as unknown as Record<string, unknown>).options =
        (rawClient as unknown as Record<string, unknown>).options;
    }

    // Create a Drizzle instance scoped to this reserved connection
    const txDb = drizzle(reservedAsSql, {
      schema,
    }) as unknown as TestDatabase;

    // Swap the global reference so any code importing `db` from `@/db`
    // (through the vi.mock) gets this transactional instance
    const previousDb = _currentDb;
    _currentDb = txDb;

    try {
      const result = await fn(txDb);
      return result;
    } finally {
      // Always rollback and restore
      _currentDb = previousDb;
      await reserved`ROLLBACK`;
    }
  } finally {
    reserved.release();
  }
}

// ---------------------------------------------------------------------------
// Module factory for vi.mock('@/db')
// ---------------------------------------------------------------------------

/**
 * Returns a module-compatible object for `vi.mock('@/db')`.
 *
 * Usage:
 *   vi.mock('@/db', async () => {
 *     const { getTestDbModule } = await import('@/test/db');
 *     return getTestDbModule();
 *   });
 */
export function getTestDbModule() {
  return {
    get db() {
      return getCurrentDb();
    },
    closeDatabase: async () => {},
    testConnection: async () => true,
    healthCheck: async () => ({
      status: "healthy" as const,
      connected: true,
      extensions: { postgis: true, pgvector: true },
    }),
    // Re-export all schema items so imports like `import { agents } from '@/db'` work
    ...schema,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Closes the shared postgres connection pool.
 *
 * Call once in `afterAll` or `globalTeardown` to release all connections
 * back to the database and allow the process to exit cleanly.
 *
 * @returns Resolves when all connections are closed.
 */
export async function closeTestDatabase(): Promise<void> {
  await rawClient.end();
}
