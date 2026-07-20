import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { authorityEventCache, AUTHORITY_STATUS } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { isPersonaOf } from "@/lib/persona";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { verifyPackedPayload } from "@/lib/federation-remote-session";
import { runWithMcpExecutionContext } from "@/lib/federation/execution-context";
import {
  getMcpToolDefinition,
  listMcpToolsForMode,
  type McpToolCallContext,
} from "@/lib/federation/mcp-tools";
import { logMcpProvenance } from "@/lib/federation/mcp-provenance";
import { timingSafeEqual } from "crypto";

/**
 * A scoped token must not keep working once the acting principal's HOME
 * authority has been revoked or superseded. Group's tokens are instance-signed
 * packed payloads with no per-token `jti`, so revocation propagates at the
 * PRINCIPAL level via `authority_event_cache` (the same signed-authority feed
 * that gates federated sessions). Best-effort/fail-open on a DB error — a cache
 * read failure must not lock out every token — but a cached revoked/superseded
 * status is a hard reject.
 */
async function isPrincipalAuthorityRevoked(agentId: string): Promise<boolean> {
  if (!agentId) return false;
  try {
    const [row] = await db
      .select({ status: authorityEventCache.authorityStatus })
      .from(authorityEventCache)
      .where(
        and(
          eq(authorityEventCache.agentId, agentId),
          inArray(authorityEventCache.authorityStatus, [
            AUTHORITY_STATUS.REVOKED,
            AUTHORITY_STATUS.SUPERSEDED,
          ]),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Constant-time string comparison (AUTH-SEC-006). Length mismatch
 * short-circuits (the lengths of these tokens are not themselves secret), but
 * equal-length inputs are compared with `timingSafeEqual` so a byte-by-byte
 * timing side-channel cannot recover the high-value static AIAGENT_MCP_TOKEN.
 */
function secureEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Shape of a personal scoped MCP token (a signed `rivr_mcp_token` payload). */
interface ScopedMcpTokenPayload {
  type?: string;
  actorId?: string;
  controllerId?: string;
  actorType?: string;
  expiresAt?: string;
  scopes?: string[];
}

/** A scoped token is expired when it has no valid future `expiresAt`. */
function isScopedTokenExpired(expiresAt?: string): boolean {
  if (!expiresAt) return true;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed <= Date.now();
}

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type McpAuthContext = McpToolCallContext;

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function successResponse(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function getQueryToken(request: Request): string | null {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  return token ? token : null;
}

async function authorizeMcpRequest(
  request: Request,
  requestedActorId?: string | null,
): Promise<McpAuthContext | null> {
  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;

  if (sessionUserId) {
    if (!requestedActorId || requestedActorId === sessionUserId) {
      return {
        actorId: sessionUserId,
        controllerId: sessionUserId,
        actorType: "human",
        authMode: "session",
      };
    }

    const ownedPersona = await isPersonaOf(requestedActorId, sessionUserId);
    if (ownedPersona) {
      return {
        actorId: requestedActorId,
        controllerId: sessionUserId,
        actorType: "persona",
        authMode: "session",
      };
    }

    return null;
  }

  const providedToken = getBearerToken(request) ?? getQueryToken(request);
  if (!providedToken) return null;

  const config = getInstanceConfig();
  const primaryAgentId = config.primaryAgentId;

  // (1) Static instance token → act as the primary group agent (autobot).
  // Constant-time compare (AUTH-SEC-006): the high-value static
  // AIAGENT_MCP_TOKEN must not be probed via a byte-wise timing side-channel.
  const configuredToken = process.env.AIAGENT_MCP_TOKEN?.trim() || "";
  if (configuredToken && secureEqualStrings(providedToken, configuredToken)) {
    if (!primaryAgentId) return null;
    if (!requestedActorId || requestedActorId === primaryAgentId) {
      return {
        actorId: primaryAgentId,
        controllerId: primaryAgentId,
        actorType: "autobot",
        authMode: "token",
      };
    }
    if (!(await isPersonaOf(requestedActorId, primaryAgentId))) return null;
    return {
      actorId: requestedActorId,
      controllerId: primaryAgentId,
      actorType: "autobot",
      authMode: "token",
    };
  }

  // (2) Personal scoped token (delegation). The token names a verified
  // controller (a human principal). We let that controller act AS an agent they
  // are authorized over: a persona they own, OR a group they administer. With
  // no explicit target we default to the instance's primary group when the
  // controller administers it — so a group's delegated agent acts as the group,
  // attributed to the group, carrying the controller as its authority.
  const scoped = verifyPackedPayload<ScopedMcpTokenPayload>(providedToken);
  if (scoped && scoped.type === "rivr_mcp_token" && !isScopedTokenExpired(scoped.expiresAt)) {
    const controllerId = (scoped.controllerId || scoped.actorId || "").trim();
    if (!controllerId) return null;

    // Home-authority revocation propagation: a token whose controlling
    // principal has had its home authority revoked/superseded must stop
    // working even though the signature and lifetime still check out.
    if (await isPrincipalAuthorityRevoked(controllerId)) return null;

    if (requestedActorId && requestedActorId !== controllerId) {
      const ownsPersona = await isPersonaOf(requestedActorId, controllerId);
      const adminsGroup = ownsPersona ? false : await isGroupAdmin(controllerId, requestedActorId);
      if (!ownsPersona && !adminsGroup) return null;
      return {
        actorId: requestedActorId,
        controllerId,
        actorType: "autobot",
        authMode: "token",
      };
    }

    if (
      primaryAgentId &&
      primaryAgentId !== controllerId &&
      (await isGroupAdmin(controllerId, primaryAgentId))
    ) {
      return {
        actorId: primaryAgentId,
        controllerId,
        actorType: "autobot",
        authMode: "token",
      };
    }

    return {
      actorId: controllerId,
      controllerId,
      actorType: "human",
      authMode: "token",
    };
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toToolContent(result: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
    isError,
  };
}

export async function handleMcpRequest(request: Request, body: JsonRpcRequest) {
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = asObject(body.params);
  const requestedActorId =
    typeof params.actorId === "string" && params.actorId.trim().length > 0
      ? params.actorId.trim()
      : null;

  if (body.jsonrpc !== "2.0") {
    return errorResponse(id, -32600, "Invalid Request", "jsonrpc must be '2.0'.");
  }

  const authContext = await authorizeMcpRequest(request, requestedActorId);
  if (!authContext) {
    return errorResponse(id, -32001, "Unauthorized", "Valid session or AIAGENT_MCP_TOKEN required.");
  }

  if (method === "initialize") {
    const config = getInstanceConfig();
    return successResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: {
        name: `rivr-${config.instanceType}-mcp`,
        version: "0.1.0",
      },
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    });
  }

  if (method === "tools/list") {
    return successResponse(id, {
      tools: listMcpToolsForMode(authContext.authMode),
    });
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const toolArgs = asObject(params.arguments);
    const tool = getMcpToolDefinition(toolName);
    if (!tool) {
      return errorResponse(id, -32601, `Unknown tool: ${toolName}`);
    }

    if (!tool.enabledFor.includes(authContext.authMode)) {
      return errorResponse(id, -32003, `Tool ${toolName} is not enabled for this auth mode.`);
    }

    const startTime = Date.now();
    try {
      const result = await runWithMcpExecutionContext(
        {
          actorId: authContext.actorId,
          controllerId: authContext.controllerId,
          actorType: authContext.actorType,
        },
        async () => tool.handler(toolArgs, authContext),
      );

      const durationMs = Date.now() - startTime;
      logMcpProvenance({
        toolName,
        context: authContext,
        args: toolArgs,
        resultStatus: "success",
        durationMs,
      }).catch(() => {});

      return successResponse(id, toToolContent(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      const durationMs = Date.now() - startTime;
      logMcpProvenance({
        toolName,
        context: authContext,
        args: toolArgs,
        resultStatus: "error",
        errorMessage: message,
        durationMs,
      }).catch(() => {});

      return successResponse(id, toToolContent({ success: false, error: message }, true));
    }
  }

  return errorResponse(id, -32601, `Method not found: ${method}`);
}

export function getMcpServerMetadata() {
  const config = getInstanceConfig();
  return {
    name: `rivr-${config.instanceType}-mcp`,
    version: "0.1.0",
    protocolVersion: MCP_PROTOCOL_VERSION,
    endpoint: "/api/mcp",
    auth: {
      session: true,
      bearerToken: Boolean(process.env.AIAGENT_MCP_TOKEN?.trim()),
      bearerTokenEnv: "AIAGENT_MCP_TOKEN",
      queryToken: Boolean(process.env.AIAGENT_MCP_TOKEN?.trim()),
    },
    instance: {
      instanceId: config.instanceId,
      instanceType: config.instanceType,
      instanceSlug: config.instanceSlug,
      primaryAgentId: config.primaryAgentId,
      baseUrl: config.baseUrl,
    },
    tools: listMcpToolsForMode("session"),
  };
}
