import { desc, eq, and, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { mcpProvenanceLog } from "@/db/schema";
import type { McpToolCallContext } from "@/lib/federation/mcp-tools";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

/** Keys stripped from args before persisting to avoid storing large payloads. */
/**
 * Substrings that mark an arg key as sensitive. Matched case-insensitively as
 * SUBSTRINGS (not exact keys) so camelCase variants (apiToken, accessToken) and
 * opaque-connector fields (apiKey, authorization) are caught — the old
 * exact-key set (token/password/secret) logged `apiToken`/`api_key`/nested
 * connector credential maps in the clear.
 */
const REDACTED_ARG_KEY_PARTS = [
  "token",
  "password",
  "secret",
  "apikey",
  "credential",
  "authorization",
];

function isSensitiveArgKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACTED_ARG_KEY_PARTS.some((part) => normalized.includes(part));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface LogMcpProvenanceParams {
  toolName: string;
  context: McpToolCallContext;
  args: Record<string, unknown>;
  resultStatus: "success" | "error";
  errorMessage?: string;
  durationMs?: number;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveArgKey(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + "\u2026";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recurse into nested maps (e.g. opaque-credential `fields`) so a secret
      // nested one level down is still redacted rather than logged in the clear.
      sanitized[key] = sanitizeArgs(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function logMcpProvenance(
  params: LogMcpProvenanceParams
): Promise<void> {
  try {
    await db.insert(mcpProvenanceLog).values({
      toolName: params.toolName,
      actorId: params.context.actorId,
      actorType: params.context.actorType,
      authMode: params.context.authMode,
      controllerId: params.context.controllerId ?? null,
      argsSummary: sanitizeArgs(params.args),
      resultStatus: params.resultStatus,
      errorMessage: params.errorMessage ?? null,
      durationMs: params.durationMs ?? null,
    });
  } catch {
    // Provenance logging must never break the primary request path.
    console.error("[mcp-provenance] Failed to write provenance log entry");
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface GetProvenanceLogParams {
  toolName?: string;
  actorId?: string;
  actorType?: "human" | "persona" | "autobot";
  resultStatus?: "success" | "error";
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

export async function getProvenanceLog(
  params: GetProvenanceLogParams = {}
): Promise<(typeof mcpProvenanceLog.$inferSelect)[]> {
  const effectiveLimit = Math.min(
    params.limit ?? DEFAULT_QUERY_LIMIT,
    MAX_QUERY_LIMIT
  );

  const conditions = [];

  if (params.toolName) {
    conditions.push(eq(mcpProvenanceLog.toolName, params.toolName));
  }
  if (params.actorId) {
    conditions.push(eq(mcpProvenanceLog.actorId, params.actorId));
  }
  if (params.actorType) {
    conditions.push(eq(mcpProvenanceLog.actorType, params.actorType));
  }
  if (params.resultStatus) {
    conditions.push(eq(mcpProvenanceLog.resultStatus, params.resultStatus));
  }
  if (params.startDate) {
    conditions.push(gte(mcpProvenanceLog.createdAt, params.startDate));
  }
  if (params.endDate) {
    conditions.push(lte(mcpProvenanceLog.createdAt, params.endDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  return db.query.mcpProvenanceLog.findMany({
    where: whereClause,
    orderBy: [desc(mcpProvenanceLog.createdAt)],
    limit: effectiveLimit,
  });
}
