// src/lib/federation/remote-write.ts

/**
 * Remote write helper for server actions.
 *
 * Provides a simplified API for server actions that need to perform
 * writes where the target might be on another instance. Wraps the
 * write-router logic so server actions don't need to manually resolve
 * home instances or handle forwarding.
 *
 * Usage in a server action:
 *
 *   import { federatedWrite } from "@/lib/federation/remote-write";
 *
 *   export async function rsvpToEvent(eventAgentId: string, rsvpStatus: string) {
 *     "use server";
 *     const session = await auth();
 *     if (!session?.user?.id) throw new Error("Not authenticated");
 *
 *     return federatedWrite({
 *       type: "rsvp",
 *       actorId: session.user.id,
 *       targetAgentId: eventAgentId,
 *       payload: { status: rsvpStatus },
 *     }, async () => {
 *       // Local execution path -- runs only if eventAgentId is homed here
 *       return executeLocalRsvp(session.user.id, eventAgentId, rsvpStatus);
 *     });
 *   }
 */

import { routeWrite, resolveWriteTarget } from "./write-router";
import type { RoutedWrite, WriteRouterResult } from "./write-router";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Simplified write descriptor for server action use.
 * Matches RoutedWrite but with all fields required for clarity.
 */
export interface FederatedWriteParams<T = unknown> {
  /** Mutation type identifier */
  type: string;
  /** Authenticated actor ID (from session) */
  actorId: string;
  /** Agent whose home instance is authoritative */
  targetAgentId: string;
  /** Mutation payload */
  payload: T;
  /** Optional idempotency key */
  idempotencyKey?: string;
  /** Optional correlation ID for tracing */
  correlationId?: string;
}

/**
 * Simplified result for server action consumers.
 */
export interface FederatedWriteResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Whether the write was executed locally or forwarded to a remote instance */
  executedOn: "local" | "remote";
  /** Slug of the instance that handled the write */
  handledBy: string;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Execute a federated write from a server action.
 *
 * Resolves the home instance for the target agent. If local, runs the
 * localExecutor directly. If remote, forwards the write to the home
 * instance's federation mutations endpoint.
 *
 * @param params - Write parameters
 * @param localExecutor - Function that executes the mutation locally
 * @returns Simplified result suitable for server action return values
 */
export async function federatedWrite<T, R = unknown>(
  params: FederatedWriteParams<T>,
  localExecutor: () => Promise<R>,
): Promise<FederatedWriteResult<R>> {
  const write: RoutedWrite<T> = {
    type: params.type,
    actorId: params.actorId,
    targetAgentId: params.targetAgentId,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
    correlationId: params.correlationId,
  };

  const result: WriteRouterResult<R> = await routeWrite(write, localExecutor);

  return {
    success: result.success,
    data: result.data,
    error: result.error,
    executedOn: result.executedOn,
    handledBy: result.homeInstance.slug,
  };
}

/**
 * Check whether a target agent is homed on this instance.
 *
 * Useful for server actions that want to branch on locality before
 * committing to a full write path (e.g., showing different UI or
 * pre-validating differently for local vs remote targets).
 *
 * @param targetAgentId - Agent to check
 * @returns Object with isLocal flag and home instance metadata
 */
export async function isLocalWrite(targetAgentId: string): Promise<{
  isLocal: boolean;
  homeInstanceSlug: string;
  homeInstanceBaseUrl: string;
}> {
  const { homeInstance, isLocal } = await resolveWriteTarget(targetAgentId);
  return {
    isLocal,
    homeInstanceSlug: homeInstance.slug,
    homeInstanceBaseUrl: homeInstance.baseUrl,
  };
}
