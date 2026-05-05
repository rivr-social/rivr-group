// src/lib/federation/write-router.ts

/**
 * Federation write router.
 *
 * Routes mutations to the correct home instance for authority.
 * When a user takes an action on a foreign instance (e.g., RSVPs to
 * an event on a group instance), the write routes back to their home
 * instance for authority.
 *
 * This builds on the existing UpdateFacade pattern but provides a
 * standalone utility focused on home-instance write routing with
 * explicit routing provenance tracking.
 */

import { resolveHomeInstance, type HomeInstanceInfo } from "./resolution";
import { getInstanceConfig } from "./instance-config";
import { emitDomainEvent, EVENT_TYPES } from "./domain-events";
import { safeOutboundUrlString } from "@/lib/safe-outbound-url";

// ─── Constants ──────────────────────────────────────────────────────────────

/** HTTP timeout for remote write requests (ms) */
const REMOTE_WRITE_TIMEOUT_MS = 30_000;

/** HTTP status code indicating the target agent is not local (Misdirected Request) */
const STATUS_MISDIRECTED = 421;

/** Standard federation mutation endpoint path */
const FEDERATION_MUTATIONS_PATH = "/api/federation/mutations";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Describes a write operation to be routed to the correct home instance.
 */
export interface RoutedWrite<T = unknown> {
  /** Mutation type identifier (e.g., "createEventResource", "rsvp") */
  type: string;
  /** Authenticated actor performing the write */
  actorId: string;
  /** Agent whose home instance is authoritative for this write */
  targetAgentId: string;
  /** Mutation-specific payload */
  payload: T;
  /** Idempotency key for dedup across retries */
  idempotencyKey?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Routing provenance attached to writes forwarded from foreign instances.
 */
export interface RoutingProvenance {
  /** Instance ID of the originating (foreign) instance */
  originInstanceId: string;
  /** Slug of the originating instance */
  originInstanceSlug: string;
  /** Base URL of the originating instance */
  originBaseUrl: string;
  /** ISO 8601 timestamp when the write was originally submitted */
  originTimestamp: string;
  /** Idempotency key from the original submission */
  idempotencyKey?: string;
  /** Correlation ID for tracing the full routing chain */
  correlationId?: string;
}

/**
 * Result of a routed write operation.
 */
export interface WriteRouterResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: WriteRouterErrorCode;
  /** Where the mutation was actually executed */
  executedOn: "local" | "remote";
  /** Home instance info for the target agent */
  homeInstance: HomeInstanceInfo;
  /** Routing provenance if the write was forwarded */
  routingProvenance?: RoutingProvenance;
}

type WriteRouterErrorCode =
  | "INSTANCE_MIGRATING"
  | "LOCAL_EXECUTION_FAILED"
  | "REMOTE_EXECUTION_FAILED"
  | "REMOTE_UNREACHABLE"
  | "REMOTE_MISDIRECTED"
  | "RESOLUTION_FAILED";

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Resolve the home instance for a given agent ID.
 *
 * Wraps the resolution module with error handling appropriate for
 * write-routing decisions.
 */
export async function resolveWriteTarget(agentId: string): Promise<{
  homeInstance: HomeInstanceInfo;
  isLocal: boolean;
}> {
  const homeInstance = await resolveHomeInstance(agentId);
  return {
    homeInstance,
    isLocal: homeInstance.isLocal,
  };
}

/**
 * Route a write to the correct home instance.
 *
 * If the target agent is homed locally, executes the mutation via the
 * provided localExecutor. If the target is on a remote instance, forwards
 * the write to the remote instance's federation mutations endpoint with
 * routing provenance attached.
 *
 * @param write - The write operation descriptor
 * @param localExecutor - Function that executes the mutation locally
 * @returns WriteRouterResult with the outcome and routing metadata
 */
export async function routeWrite<T, R = unknown>(
  write: RoutedWrite<T>,
  localExecutor: () => Promise<R>,
): Promise<WriteRouterResult<R>> {
  let homeInstance: HomeInstanceInfo;

  try {
    homeInstance = await resolveHomeInstance(write.targetAgentId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to resolve home instance",
      errorCode: "RESOLUTION_FAILED",
      executedOn: "local",
      homeInstance: {
        nodeId: "",
        instanceType: "global",
        slug: "unknown",
        baseUrl: "",
        isLocal: false,
        migrationStatus: "unknown",
      },
    };
  }

  // Reject writes to instances that are migrating out or archived
  if (homeInstance.migrationStatus === "migrating_out" || homeInstance.migrationStatus === "archived") {
    return {
      success: false,
      error: `Instance ${homeInstance.slug} is ${homeInstance.migrationStatus}. Writes are temporarily unavailable.`,
      errorCode: "INSTANCE_MIGRATING",
      executedOn: "local",
      homeInstance,
    };
  }

  if (homeInstance.isLocal) {
    return executeLocally(localExecutor, homeInstance);
  }

  return forwardToHomeInstance(write, homeInstance);
}

// ─── Local Execution ────────────────────────────────────────────────────────

async function executeLocally<R>(
  localExecutor: () => Promise<R>,
  homeInstance: HomeInstanceInfo,
): Promise<WriteRouterResult<R>> {
  try {
    const data = await localExecutor();
    return {
      success: true,
      data,
      executedOn: "local",
      homeInstance,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Local execution failed",
      errorCode: "LOCAL_EXECUTION_FAILED",
      executedOn: "local",
      homeInstance,
    };
  }
}

// ─── Remote Forwarding ──────────────────────────────────────────────────────

async function forwardToHomeInstance<T, R>(
  write: RoutedWrite<T>,
  homeInstance: HomeInstanceInfo,
): Promise<WriteRouterResult<R>> {
  const config = getInstanceConfig();
  const idempotencyKey = write.idempotencyKey || crypto.randomUUID();
  const correlationId = write.correlationId || crypto.randomUUID();
  const originTimestamp = new Date().toISOString();

  const routingProvenance: RoutingProvenance = {
    originInstanceId: config.instanceId,
    originInstanceSlug: config.instanceSlug,
    originBaseUrl: config.baseUrl,
    originTimestamp,
    idempotencyKey,
    correlationId,
  };

  try {
    const url = safeOutboundUrlString(new URL(FEDERATION_MUTATIONS_PATH, homeInstance.baseUrl), {
      protocols: ["https:", "http:"],
    });

    console.log(
      `[write-router] Forwarding write to home instance ${homeInstance.slug} (${homeInstance.nodeId}):`,
      { type: write.type, targetAgentId: write.targetAgentId, url },
    );

    // Cross-instance auth: prefer peer-secret (per-peer scoped) over the
    // global admin key. Receiver hashes the secret and matches against its
    // node_peers row keyed by our slug.
    const peerSecretEnv = `FEDERATION_PEER_SECRET_${homeInstance.slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const peerSecret = process.env[peerSecretEnv]?.trim();
    const adminKey = process.env.NODE_ADMIN_KEY?.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Instance-Id": config.instanceId,
      "X-Instance-Slug": config.instanceSlug,
      "X-Idempotency-Key": idempotencyKey,
      "X-Correlation-Id": correlationId,
    };
    if (peerSecret) {
      headers["x-peer-slug"] = config.instanceSlug;
      headers["x-peer-secret"] = peerSecret;
    } else if (adminKey) {
      headers["X-Node-Admin-Key"] = adminKey;
    } else {
      console.warn(
        `[write-router] No ${peerSecretEnv} or NODE_ADMIN_KEY configured for forward to ${homeInstance.slug}; ` +
          `the receiver will reject this request.`,
      );
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: write.type,
        actorId: write.actorId,
        targetAgentId: write.targetAgentId,
        payload: write.payload,
        routedFrom: routingProvenance,
      }),
      signal: AbortSignal.timeout(REMOTE_WRITE_TIMEOUT_MS),
    });

    if (response.status === STATUS_MISDIRECTED) {
      // The remote instance says the agent isn't local to it either --
      // this indicates a registry inconsistency
      const errorBody = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorBody.error || `Agent ${write.targetAgentId} not found on resolved home instance ${homeInstance.slug}`,
        errorCode: "REMOTE_MISDIRECTED",
        executedOn: "remote",
        homeInstance,
        routingProvenance,
      };
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorBody.error || `Remote instance returned HTTP ${response.status}`,
        errorCode: "REMOTE_EXECUTION_FAILED",
        executedOn: "remote",
        homeInstance,
        routingProvenance,
      };
    }

    const result = await response.json();

    // Emit a local domain event recording the routed write for audit
    await emitDomainEvent({
      eventType: "federation.write_routed",
      entityType: "mutation",
      entityId: write.targetAgentId,
      actorId: write.actorId,
      payload: {
        mutationType: write.type,
        targetAgentId: write.targetAgentId,
        homeInstanceSlug: homeInstance.slug,
        homeInstanceNodeId: homeInstance.nodeId,
        remoteSuccess: result.success ?? true,
      },
      correlationId,
    });

    return {
      success: result.success ?? true,
      data: result.data as R,
      executedOn: "remote",
      homeInstance,
      routingProvenance,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Remote instance unreachable",
      errorCode: "REMOTE_UNREACHABLE",
      executedOn: "remote",
      homeInstance,
      routingProvenance,
    };
  }
}
