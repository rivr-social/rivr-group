import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import * as kg from "@/lib/kg/autobot-kg-client";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { getProvenanceLog } from "@/lib/federation/mcp-provenance";
import { serializeAgent } from "@/lib/graph-serializers";
import { and, eq, isNull } from "drizzle-orm";

export type McpToolCallContext = {
  actorId: string;
  controllerId?: string;
  actorType: "human" | "persona" | "autobot";
  authMode: "session" | "token";
};

export type McpToolResult = unknown;

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabledFor: Array<"session" | "token">;
  handler: (args: Record<string, unknown>, context: McpToolCallContext) => Promise<McpToolResult>;
};

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function listPersonasForController(context: McpToolCallContext) {
  const controllerId = context.controllerId ?? context.actorId;

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, controllerId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(agents.createdAt);

  const activePersona =
    context.actorType === "persona"
      ? rows.find((row) => row.id === context.actorId) ?? null
      : null;

  return {
    success: true,
    personas: rows.map((row) => serializeAgent(row)),
    activePersonaId: activePersona?.id ?? null,
    activePersona: activePersona ? serializeAgent(activePersona) : null,
  };
}

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "rivr.instance.get_context",
    description: "Return the local Rivr group instance identity and the authenticated actor context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async (_args, context) => {
      const config = getInstanceConfig();
      const homeInstance = await resolveHomeInstance(context.actorId).catch(() => null);
      return {
        actorId: context.actorId,
        controllerId: context.controllerId ?? null,
        actorType: context.actorType,
        authMode: context.authMode,
        instance: config,
        homeInstance,
      };
    },
  },
  {
    name: "rivr.personas.list",
    description: "List personas owned by the current controller and return the active persona.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async (_args, context) => listPersonasForController(context),
  },
  {
    name: "rivr.kg.list_docs",
    description: "List knowledge graph documents for a scope. Defaults to group scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_type: { type: "string", description: "Scope type (group, person, persona, event, project). Default: group" },
        scope_id: { type: "string", description: "Scope ID. Default: instance primary agent ID or current actor ID" },
        status: { type: "string", description: "Filter by doc status (pending, ingesting, complete, failed)" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const config = getInstanceConfig();
      const scopeType = getString(args.scope_type) ?? "group";
      const scopeId = getString(args.scope_id) ?? config.primaryAgentId ?? context.actorId;
      const status = getString(args.status) ?? undefined;
      const docs = await kg.listDocs(scopeType, scopeId, status);
      return { success: true, docs, count: docs.length };
    },
  },
  {
    name: "rivr.kg.push_doc",
    description: "Push a Rivr resource into the knowledge graph for extraction. Creates a doc record and ingests its content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId"],
      properties: {
        resourceId: { type: "string", description: "ID of the Rivr resource to push" },
        scope_type: { type: "string", description: "Scope type. Default: group" },
        scope_id: { type: "string", description: "Scope ID. Default: instance primary agent ID or current actor ID" },
        title: { type: "string", description: "Override title for the doc" },
        doc_type: { type: "string", description: "Doc type classification" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const resourceId = getString(args.resourceId);
      if (!resourceId) throw new Error("resourceId is required.");

      const resource = await db.query.resources.findFirst({
        where: eq(resources.id, resourceId),
      });
      if (!resource) throw new Error("Resource not found.");
      const ownerId = context.controllerId ?? context.actorId;
      if (resource.ownerId !== ownerId) throw new Error("Not your resource.");

      const config = getInstanceConfig();
      const scopeType = getString(args.scope_type) ?? "group";
      const scopeId = getString(args.scope_id) ?? config.primaryAgentId ?? context.actorId;

      const doc = await kg.createDoc({
        title: getString(args.title) ?? resource.name ?? "Untitled",
        doc_type: getString(args.doc_type) ?? resource.type ?? "resource",
        scope_type: scopeType,
        scope_id: scopeId,
        source_uri: `rivr://group/resources/${resource.id}`,
      });

      const content = resource.content || "";
      if (!content) {
        return { success: true, doc, ingested: false, reason: "Resource has no content to ingest" };
      }

      const result = await kg.ingestDoc(doc.id, content, undefined, doc.title);
      return { success: true, doc, ingested: true, ingestResult: result };
    },
  },
  {
    name: "rivr.kg.query",
    description: "Query the scoped knowledge graph subgraph. Returns triples (subject-predicate-object facts) from the KG.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_type: { type: "string", description: "Scope type. Default: group" },
        scope_id: { type: "string", description: "Scope ID. Default: instance primary agent ID or current actor ID" },
        entity: { type: "string", description: "Filter triples by entity name" },
        predicate: { type: "string", description: "Filter triples by predicate type" },
        max_results: { type: "number", description: "Maximum number of triples to return" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const config = getInstanceConfig();
      const scopeType = getString(args.scope_type) ?? "group";
      const scopeId = getString(args.scope_id) ?? config.primaryAgentId ?? context.actorId;
      const result = await kg.queryScope(scopeType, scopeId, {
        entity: getString(args.entity) ?? undefined,
        predicate: getString(args.predicate) ?? undefined,
        max_results: typeof args.max_results === "number" ? args.max_results : undefined,
      });
      return { success: true, ...result };
    },
  },
  {
    name: "rivr.kg.chat",
    description: "Chat with knowledge graph context. Fetches relevant KG facts for the group scope and uses them to inform the response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", description: "The user's message/question" },
        scope_type: { type: "string", description: "Scope type. Default: group" },
        scope_id: { type: "string", description: "Scope ID. Default: instance primary agent ID or current actor ID" },
        max_context_chars: { type: "number", description: "Max chars of KG context to inject. Default: 3000" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const message = getString(args.message);
      if (!message) throw new Error("message is required.");

      const config = getInstanceConfig();
      const scopeType = getString(args.scope_type) ?? "group";
      const scopeId = getString(args.scope_id) ?? config.primaryAgentId ?? context.actorId;
      const maxChars = typeof args.max_context_chars === "number" ? args.max_context_chars : 3000;

      const { context: kgContext } = await kg.buildContext(scopeType, scopeId, maxChars);

      const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
      const kgSystemPrompt = kgContext
        ? `You have access to a knowledge graph for this ${scopeType}. Use these facts to inform your answers:\n\n${kgContext}\n\n`
        : "";

      const openclawRes = await fetch(`${OPENCLAW_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: context.actorId,
          message: `${kgSystemPrompt}User question: ${message}`,
          history: [],
          channel: `kg-chat:${scopeType}:${scopeId}`,
        }),
      });

      if (!openclawRes.ok) {
        const errText = await openclawRes.text();
        throw new Error(`OpenClaw error: ${openclawRes.status} — ${errText}`);
      }

      const data = await openclawRes.json();
      return {
        success: true,
        ...data,
        kg_context_length: kgContext.length,
        scope: { type: scopeType, id: scopeId },
      };
    },
  },
  {
    name: "rivr.audit.recent",
    description: "Return recent MCP provenance log entries. Useful for reviewing autobot activity and debugging.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolName: { type: "string", description: "Filter by tool name" },
        actorType: { type: "string", enum: ["human", "persona", "autobot"] },
        resultStatus: { type: "string", enum: ["success", "error"] },
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const entries = await getProvenanceLog({
        toolName: getString(args.toolName) ?? undefined,
        actorType: getString(args.actorType) as "human" | "persona" | "autobot" | undefined,
        resultStatus: getString(args.resultStatus) as "success" | "error" | undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return { success: true, entries, count: entries.length };
    },
  },
];

export function listMcpToolsForMode(mode: "session" | "token") {
  return MCP_TOOL_DEFINITIONS.filter((tool) => tool.enabledFor.includes(mode)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function getMcpToolDefinition(name: string) {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}
