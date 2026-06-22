import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { createPostResource } from "@/app/actions/resource-creation/posts";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { getPlacesByPlaceType } from "@/lib/queries/agents";
import { GLOBAL_BASE_URL } from "@/lib/global-base-url";
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

function getBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    name: "rivr.places.list",
    description: "List the places (locales/chapters and regions/bioregions) that posts, events, and offerings can be scoped to. Call this to resolve a place NAME (e.g. \"Boulder\") to the canonical id you pass as localeId/regionId (or scopedLocaleIds/scopedRegionIds) on the create tools. The catalog is the federation-wide canonical directory served by the global instance (the same list the locale switcher shows), NOT just places that happen to live on this sovereign instance. Optionally filter by name substring (query) and/or restrict to a kind (placeType: \"locale\" or \"region\").",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring to match against place name." },
        placeType: { type: "string", enum: ["locale", "region", "all"], description: "Restrict to locales/chapters, regions/bioregions, or both (default)." },
        limit: { type: "number", description: "Max places per kind. Defaults to 50." },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const query = getString(args.query)?.trim().toLowerCase() ?? null;
      const placeType = getString(args.placeType) ?? "all";
      const limit = getNumber(args.limit) ?? 50;
      const wantLocales = placeType === "all" || placeType === "locale";
      const wantRegions = placeType === "all" || placeType === "region";
      const matches = (name: string) => !query || name.toLowerCase().includes(query);

      // The canonical place catalog (Boulder, Denver, the basins/regions, etc.)
      // lives on the GLOBAL instance, not in this sovereign instance's local DB
      // (the locale switcher reads the same global directory rather than whatever
      // happens to be projected locally). Fetch global's /api/locales — it returns
      // every chapter agent plus its parent basin, from which we derive the region
      // list. Fall back to the local place agents if global is unreachable.
      type PlaceEntry = { id: string; name: string; kind: "locale" | "region"; slug: string | null; basinId?: string | null; basinName?: string | null };
      let locales: PlaceEntry[] = [];
      let regions: PlaceEntry[] = [];
      let source = "global";

      try {
        const res = await fetch(`${GLOBAL_BASE_URL}/api/locales`, { cache: "no-store" });
        if (!res.ok) throw new Error(`global /api/locales responded ${res.status}`);
        const data = (await res.json()) as {
          locales?: Array<Record<string, unknown>>;
        };
        const rows = Array.isArray(data.locales) ? data.locales : [];
        locales = rows.map((row) => ({
          id: String(row.id ?? row.slug ?? ""),
          name: String(row.name ?? row.slug ?? ""),
          kind: "locale" as const,
          slug: typeof row.slug === "string" ? row.slug : null,
          basinId: typeof row.basinId === "string" ? row.basinId : null,
          basinName: typeof row.basinName === "string" ? row.basinName : null,
        })).filter((p) => p.id);

        // Regions/basins are denormalized onto each locale row — dedupe them.
        const regionById = new Map<string, PlaceEntry>();
        for (const loc of locales) {
          if (loc.basinId && loc.basinName && !regionById.has(loc.basinId)) {
            regionById.set(loc.basinId, {
              id: loc.basinId,
              name: loc.basinName,
              kind: "region",
              slug: null,
            });
          }
        }
        regions = Array.from(regionById.values());
      } catch {
        // Global unreachable — degrade to whatever place agents this instance
        // has locally so the tool still returns something usable offline.
        source = "local";
        const toLocal = (kind: "locale" | "region") => (agent: { id: string; name: string; metadata?: Record<string, unknown> | null }) => {
          const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
          return {
            id: agent.id,
            name: agent.name,
            kind,
            slug:
              (metadata.slug as string | undefined) ??
              (metadata.username as string | undefined) ??
              null,
          } satisfies PlaceEntry;
        };
        const [localLocales, localRegions] = await Promise.all([
          getPlacesByPlaceType("locale", limit),
          getPlacesByPlaceType("region", limit),
        ]);
        locales = localLocales.map(toLocal("locale"));
        regions = localRegions.map(toLocal("region"));
      }

      return {
        source,
        locales: wantLocales ? locales.filter((p) => matches(p.name)).slice(0, limit) : [],
        regions: wantRegions ? regions.filter((p) => matches(p.name)).slice(0, limit) : [],
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
    name: "rivr.posts.create",
    description:
      "Create a post as the active actor. Pass groupId (typically this instance's primary group) to post into a group the actor has write access to; group posting requires membership/admin write access. Pass ownerId to post AS a group the actor administers — the post is then owned by and homes on that group. Scope the post to a place by passing localeId (a locale/chapter) and/or regionId (a region/bioregion); use rivr.places.list to resolve a place name to its id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        postType: { type: "string" },
        groupId: { type: "string", description: "Group to post into. Defaults to a personal post when omitted." },
        ownerId: {
          type: "string",
          description: "Post AS this group (the actor must have write access). The post is owned by and homes on the group.",
        },
        localeId: {
          type: "string",
          description: "Scope the post to this locale/chapter (a place-typed agent id, e.g. \"Boulder\"). Resolve names to ids with rivr.places.list. Place-scoping makes the post discoverable in that locale's feed.",
        },
        regionId: {
          type: "string",
          description: "Scope the post to this region/bioregion (a place-typed agent id, e.g. a basin or front-range region). Resolve names to ids with rivr.places.list. May be combined with localeId.",
        },
        scopedLocaleIds: {
          type: "array",
          items: { type: "string" },
          description: "Scope the post to multiple locales/chapters at once (place-typed agent ids).",
        },
        scopedRegionIds: {
          type: "array",
          items: { type: "string" },
          description: "Scope the post to multiple regions/bioregions at once (place-typed agent ids).",
        },
        imageUrl: { type: "string" },
        isGlobal: { type: "boolean", description: "Whether the post is federation-projectable. Default: true" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const content = getString(args.content);
      if (!content) {
        throw new Error("content is required.");
      }

      // Extract URLs from the body so posts created via MCP get the same
      // rich embed rendering as posts composed through the UI. Each URL
      // becomes a `{url, kind: 'link'}` embed resolved client-side by
      // LinkPreviewCard — no server-side link-preview scrape required.
      const { extractUrls } = await import("@/lib/link-preview-client");
      const urls = extractUrls(content);
      const embeds = urls.map((url) => ({ url, kind: "link" as const }));

      return createPostResource({
        title: getString(args.title) ?? undefined,
        content,
        postType: getString(args.postType) ?? "social",
        groupId: getString(args.groupId) ?? undefined,
        ownerId: getString(args.ownerId) ?? undefined,
        localeId: getString(args.localeId) ?? undefined,
        regionId: getString(args.regionId) ?? undefined,
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedRegionIds: getStringArray(args.scopedRegionIds),
        imageUrl: getString(args.imageUrl),
        isGlobal: getBoolean(args.isGlobal, true),
        embeds,
      });
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
