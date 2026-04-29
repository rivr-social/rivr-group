// src/lib/federation/update-facade.ts

import { resolveHomeInstance, type HomeInstanceInfo } from "./resolution";
import { getInstanceConfig } from "./instance-config";
import { safeOutboundUrlString } from "@/lib/safe-outbound-url";

/**
 * Mutation descriptor for the update facade.
 */
export interface Mutation<T = unknown> {
  /** Mutation type identifier matching the server action name */
  type: string;
  /** Authenticated actor performing the mutation */
  actorId: string;
  /** Agent whose home instance should handle this mutation */
  targetAgentId: string;
  /** Mutation-specific input data */
  payload: T;
  /** Idempotency key for dedup */
  idempotencyKey?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
}

/**
 * Result of a mutation execution.
 */
export interface MutationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  executedOn: "local" | "remote";
}

/**
 * UpdateFacade routes every write to the correct home instance.
 *
 * Phase 1: Pass-through. resolveHomeInstance() returns local for all agents
 * (since only the global instance exists). The facade adds no overhead beyond
 * the resolution check.
 *
 * Phase 2+: Remote forwarding. When an agent's home instance is remote,
 * the facade forwards the mutation via HTTP POST to the target instance's
 * federation mutation API.
 */
export class UpdateFacade {
  /**
   * Execute a mutation, routing to the correct home instance.
   *
   * @param mutation - Describes what to do and whose instance should handle it
   * @param localExecutor - Function that executes the mutation locally (the existing server action logic)
   * @returns MutationResult with the outcome
   */
  async execute<T, R = unknown>(
    mutation: Mutation<T>,
    localExecutor: () => Promise<R>
  ): Promise<MutationResult<R>> {
    // Resolve where this mutation should execute
    const homeInstance = await resolveHomeInstance(mutation.targetAgentId);

    // Check migration status — reject writes to migrating instances
    if (homeInstance.migrationStatus === 'migrating_out' || homeInstance.migrationStatus === 'archived') {
      return {
        success: false,
        error: `Instance ${homeInstance.slug} is ${homeInstance.migrationStatus}. Writes are temporarily unavailable.`,
        errorCode: 'INSTANCE_MIGRATING',
        executedOn: 'local',
      };
    }

    if (homeInstance.isLocal) {
      // Local execution — run the mutation directly
      return this.executeLocally(localExecutor);
    } else {
      // Remote execution — forward to the home instance
      return this.executeRemotely(mutation, homeInstance);
    }
  }

  private async executeLocally<R>(localExecutor: () => Promise<R>): Promise<MutationResult<R>> {
    try {
      const data = await localExecutor();
      return {
        success: true,
        data,
        executedOn: 'local',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorCode: 'LOCAL_EXECUTION_FAILED',
        executedOn: 'local',
      };
    }
  }

  private async executeRemotely<T, R>(
    mutation: Mutation<T>,
    homeInstance: HomeInstanceInfo
  ): Promise<MutationResult<R>> {
    try {
      const config = getInstanceConfig();

      const mutationUrl = safeOutboundUrlString(
        new URL("/api/federation/mutations", homeInstance.baseUrl),
        { protocols: ["https:", "http:"] },
      );

      const response = await fetch(mutationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Instance-Id': config.instanceId,
          'X-Instance-Slug': config.instanceSlug,
          'X-Idempotency-Key': mutation.idempotencyKey || crypto.randomUUID(),
          ...(mutation.correlationId ? { 'X-Correlation-Id': mutation.correlationId } : {}),
          ...(process.env.NODE_ADMIN_KEY?.trim()
            ? { 'X-Node-Admin-Key': process.env.NODE_ADMIN_KEY.trim() }
            : {}),
        },
        body: JSON.stringify({
          type: mutation.type,
          actorId: mutation.actorId,
          targetAgentId: mutation.targetAgentId,
          payload: mutation.payload,
        }),
        signal: AbortSignal.timeout(30_000), // 30s timeout
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        return {
          success: false,
          error: errorBody.error || `Remote instance returned ${response.status}`,
          errorCode: 'REMOTE_EXECUTION_FAILED',
          executedOn: 'remote',
        };
      }

      const result = await response.json();
      return {
        success: result.success ?? true,
        data: result.data as R,
        executedOn: 'remote',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Remote instance unreachable',
        errorCode: 'REMOTE_UNREACHABLE',
        executedOn: 'remote',
      };
    }
  }
}

/** Singleton instance */
export const updateFacade = new UpdateFacade();
