// src/lib/federation/query-facade.ts

import { resolveHomeInstance, type HomeInstanceInfo } from "./resolution";
import { getInstanceConfig } from "./instance-config";

/**
 * Source of data for a query result.
 */
export type DataSource = "local" | "projection" | "remote";

/**
 * Query result wrapper that includes source metadata.
 */
export interface QueryResult<T> {
  data: T;
  source: DataSource;
  /** When this data was last verified fresh */
  freshnessMs: number;
  /** The instance that owns this data */
  sourceInstanceId?: string;
}

/**
 * QueryFacade resolves reads from the best available source:
 * 1. Local DB (if this instance owns the data)
 * 2. Local projection (cached copy from federation sync)
 * 3. Remote fetch (from the authoritative home instance)
 *
 * Phase 1: Pass-through. All queries run locally because only the
 * global instance exists. Zero overhead.
 *
 * Phase 2+: Projections and remote fetch become active.
 */
export class QueryFacade {
  /**
   * Execute a query, resolving the best data source.
   *
   * @param queryName - Name of the query for logging/tracing
   * @param targetAgentId - Agent whose data is being queried (determines source)
   * @param localExecutor - Function that executes the query against local DB
   * @returns QueryResult with data and source metadata
   */
  async query<T>(
    queryName: string,
    targetAgentId: string | null,
    localExecutor: () => Promise<T>
  ): Promise<QueryResult<T>> {
    // If no target agent (e.g., global feed, search), always run locally
    if (!targetAgentId) {
      return this.executeLocally(localExecutor);
    }

    const homeInstance = await resolveHomeInstance(targetAgentId);

    if (homeInstance.isLocal) {
      // Data lives on this instance — query directly
      return this.executeLocally(localExecutor);
    }

    // Phase 1: Even for remote data, try local first (projection may exist)
    // If local returns null/empty, could fetch remotely in Phase 2+
    try {
      const localResult = await localExecutor();
      if (localResult !== null && localResult !== undefined) {
        return {
          data: localResult,
          source: "projection",
          freshnessMs: Date.now(),
          sourceInstanceId: homeInstance.nodeId,
        };
      }
    } catch {
      // Local query failed — fall through to remote
    }

    // Phase 2+: Remote fetch
    return this.fetchRemotely<T>(queryName, targetAgentId, homeInstance);
  }

  /**
   * Execute a query that doesn't target a specific agent.
   * Always runs locally (feeds, search, discovery).
   */
  async queryLocal<T>(
    queryName: string,
    localExecutor: () => Promise<T>
  ): Promise<QueryResult<T>> {
    return this.executeLocally(localExecutor);
  }

  private async executeLocally<T>(localExecutor: () => Promise<T>): Promise<QueryResult<T>> {
    const data = await localExecutor();
    return {
      data,
      source: "local",
      freshnessMs: Date.now(),
    };
  }

  private async fetchRemotely<T>(
    queryName: string,
    targetAgentId: string,
    homeInstance: HomeInstanceInfo
  ): Promise<QueryResult<T>> {
    try {
      const config = getInstanceConfig();

      const response = await fetch(
        `${homeInstance.baseUrl}/api/federation/query?` +
        new URLSearchParams({
          queryName,
          targetAgentId,
        }),
        {
          headers: {
            'X-Instance-Id': config.instanceId,
            'X-Instance-Slug': config.instanceSlug,
          },
          signal: AbortSignal.timeout(10_000), // 10s timeout for reads
        }
      );

      if (!response.ok) {
        throw new Error(`Remote query failed: ${response.status}`);
      }

      const result = await response.json();
      return {
        data: result.data as T,
        source: "remote",
        freshnessMs: Date.now(),
        sourceInstanceId: homeInstance.nodeId,
      };
    } catch (error) {
      // Remote fetch failed — return empty/null
      // In Phase 2+, this would fall back to stale projection
      throw new Error(
        `Cannot resolve data for agent ${targetAgentId}: ` +
        `home instance ${homeInstance.slug} (${homeInstance.baseUrl}) unreachable`
      );
    }
  }
}

/** Singleton instance */
export const queryFacade = new QueryFacade();
