/**
 * Client-side persistent data store using Dexie (IndexedDB).
 *
 * These tables mirror the server's semantic graph and act as the user's
 * private offline-capable data cache. Data syncs from the server when online
 * and is served locally for instant reads.
 *
 * Tables:
 * - `agents`    — people, groups, chapters, basins, orgs
 * - `resources` — posts, events, badges, documents, listings, vouchers
 * - `ledger`    — interactions, memberships, transactions
 * - `syncMeta`  — per-collection sync timestamps for staleness checks
 */

import Dexie, { type EntityTable } from "dexie";

export interface LocalAgent {
  id: string;
  name: string;
  type: string;
  description: string | null;
  email: string | null;
  image: string | null;
  metadata: Record<string, unknown>;
  parentId: string | null;
  pathIds: string[];
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalResource {
  id: string;
  name: string;
  type: string;
  description: string | null;
  content: string | null;
  url: string | null;
  ownerId: string;
  isPublic: boolean;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalLedgerEntry {
  id: string;
  subjectId: string;
  verb: string;
  objectId: string;
  objectType: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  isActive: boolean;
}

export interface SyncMeta {
  collection: string;
  lastSyncedAt: number;
  itemCount: number;
}

class RivrLocalDB extends Dexie {
  agents!: EntityTable<LocalAgent, "id">;
  resources!: EntityTable<LocalResource, "id">;
  ledger!: EntityTable<LocalLedgerEntry, "id">;
  syncMeta!: EntityTable<SyncMeta, "collection">;

  constructor() {
    super("rivr-local");

    this.version(1).stores({
      agents: "id, type, parentId, *pathIds, name, updatedAt",
      resources: "id, type, ownerId, *tags, name, updatedAt",
      ledger: "id, subjectId, verb, objectId, objectType, timestamp",
      syncMeta: "collection",
    });
  }
}

export const localDb = new RivrLocalDB();

/** Default staleness threshold: 5 minutes */
const DEFAULT_STALE_MS = 1000 * 60 * 5;

/**
 * Check if a collection needs a fresh sync from the server.
 */
export async function isStale(
  collection: string,
  maxAgeMs = DEFAULT_STALE_MS
): Promise<boolean> {
  const meta = await localDb.syncMeta.get(collection);
  if (!meta) return true;
  return Date.now() - meta.lastSyncedAt > maxAgeMs;
}

/**
 * Mark a collection as freshly synced.
 */
export async function markSynced(
  collection: string,
  itemCount: number
): Promise<void> {
  await localDb.syncMeta.put({
    collection,
    lastSyncedAt: Date.now(),
    itemCount,
  });
}

/**
 * Upsert agents into the local store. Uses bulkPut for efficiency.
 */
export async function upsertAgents(agents: LocalAgent[]): Promise<void> {
  if (agents.length === 0) return;
  await localDb.agents.bulkPut(agents);
}

/**
 * Upsert resources into the local store.
 */
export async function upsertResources(resources: LocalResource[]): Promise<void> {
  if (resources.length === 0) return;
  await localDb.resources.bulkPut(resources);
}

/**
 * Upsert ledger entries into the local store.
 */
export async function upsertLedger(entries: LocalLedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await localDb.ledger.bulkPut(entries);
}

/**
 * Get agents by type from local store.
 */
export async function getLocalAgentsByType(
  type: string,
  limit = 50
): Promise<LocalAgent[]> {
  return localDb.agents
    .where("type")
    .equals(type)
    .limit(limit)
    .toArray();
}

/**
 * Get resources by type from local store.
 */
export async function getLocalResourcesByType(
  type: string,
  limit = 50
): Promise<LocalResource[]> {
  return localDb.resources
    .where("type")
    .equals(type)
    .limit(limit)
    .toArray();
}

/**
 * Get resources owned by a specific agent.
 */
export async function getLocalResourcesByOwner(
  ownerId: string,
  limit = 200
): Promise<LocalResource[]> {
  return localDb.resources
    .where("ownerId")
    .equals(ownerId)
    .limit(limit)
    .toArray();
}

/**
 * Get a single agent by ID.
 */
export async function getLocalAgent(id: string): Promise<LocalAgent | undefined> {
  return localDb.agents.get(id);
}

/**
 * Get a single resource by ID.
 */
export async function getLocalResource(id: string): Promise<LocalResource | undefined> {
  return localDb.resources.get(id);
}

/**
 * Search agents by name prefix (case-insensitive).
 */
export async function searchLocalAgents(
  query: string,
  limit = 20
): Promise<LocalAgent[]> {
  const lower = query.toLowerCase();
  return localDb.agents
    .filter((a) => a.name.toLowerCase().includes(lower))
    .limit(limit)
    .toArray();
}

/**
 * Clear all local data (useful for logout or data reset).
 */
export async function clearLocalData(): Promise<void> {
  await Promise.all([
    localDb.agents.clear(),
    localDb.resources.clear(),
    localDb.ledger.clear(),
    localDb.syncMeta.clear(),
  ]);
}
