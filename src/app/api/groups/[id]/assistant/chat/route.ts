/**
 * POST /api/groups/[id]/assistant/chat
 *
 * The sovereign group's AI assistant chat surface. ONE endpoint serves both:
 *   - the admin/owner self-surface (full-scope, not rate-limited), and
 *   - the outward-facing visitor surface (rate-limited + ABAC-scoped to the
 *     viewer via the instance's federated visitor policy).
 *
 * The assistant is the group's direct agent (an autobot-enabled child persona,
 * or the group agent itself) resolved by `resolveGroupDirectAgent`. KG context
 * is scoped to the caller's tier so private/member-only knowledge never leaks
 * to visitors.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/get-session";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveVisitorScope } from "@/lib/federation/visitor-scope";
import { isGroupAdmin, isGroupMember } from "@/app/actions/group-admin";
import { resolveGroupDirectAgent } from "@/lib/group-assistant";
import {
  resolveAssistantAccess,
  type AssistantCallerTier,
  type AssistantKgScope,
} from "@/lib/group-assistant-access";
import { getAgent } from "@/lib/queries/agents";
import { buildContext } from "@/lib/kg/autobot-kg-client";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  nativeCloudChat,
  type HistoryMessage,
} from "@/lib/ai/native-chat";
import { buildGroupConnectorTools } from "@/lib/connectors/assistant-tools";
import { buildGroupActionToolset } from "@/lib/federation/group-action-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_HISTORY_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;
const KG_CONTEXT_MAX_CHARS = 3000;

/** Rate-limit budget for outward-facing (non-exempt) assistant callers. */
const ASSISTANT_RATE_LIMIT = RATE_LIMITS.SOCIAL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssistantChatRequestBody {
  message: string;
  history?: HistoryMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGroupAssistantSystemPrompt(
  groupName: string,
  groupDescription: string,
  kgScope: AssistantKgScope,
  customSoulMd: string,
  baseUrl: string,
): string {
  const audienceLine =
    kgScope === "full"
      ? "You are speaking with a group admin. You may discuss group operations and configuration."
      : kgScope === "member"
        ? "You are speaking with a group member. Share member-level information; do not reveal admin-only operational details."
        : "You are speaking with a public visitor. Share only public information about the group.";

  const base = `You are the AI assistant for the Rivr group "${groupName}".

## Who You Represent
- Group: ${groupName}
- About: ${groupDescription || "Not provided"}
- Home: ${baseUrl}

## Audience
${audienceLine}

## Behavioral Guidelines
- You represent the group as a helpful, conversational assistant.
- You are an AI assistant, not a human member. If asked, say so honestly.
- Never reveal private or member-only information to public visitors.
- Do not invent facts about the group; if you don't know, say so.
- Keep responses concise and helpful.`;

  if (customSoulMd) {
    return `${base}\n\n## Operator Instructions\n${customSoulMd}`;
  }
  return base;
}

/**
 * Map the assistant KG scope to a KG `scope_type`. Public/member callers read
 * the group's public KG scope; admins read the broader group scope.
 */
function kgScopeTypeFor(scope: AssistantKgScope): string {
  return scope === "full" ? "group" : "group-public";
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: groupId } = await params;
  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
  }

  // ---- Resolve the caller and classify their tier ------------------------
  const session = await getSession();
  const config = getInstanceConfig();

  let tier: AssistantCallerTier;
  let rateLimitIdentity: string;

  if (session?.user?.id) {
    const actorId = session.user.id;
    rateLimitIdentity = `actor:${actorId}`;
    if (config.primaryAgentId && actorId === config.primaryAgentId) {
      tier = "owner";
    } else if (await isGroupAdmin(actorId, groupId)) {
      tier = "admin";
    } else if (await isGroupMember(actorId, groupId)) {
      tier = "member";
    } else if (session.user.authMethod === "federated") {
      // Authenticated via the cross-instance SSO cookie but not a member.
      tier = "visitor";
    } else {
      // Local non-member, non-admin: treated as a visitor for scoping.
      tier = "visitor";
    }
  } else {
    tier = "anonymous";
    // Best-effort per-IP identity for anonymous rate limiting.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    rateLimitIdentity = `ip:${ip}`;
  }

  // ---- Resolve the group's direct agent (the assistant) ------------------
  const direct = await resolveGroupDirectAgent(groupId);
  const publicChatEnabled = direct.settings.publicChatEnabled;

  // ---- Apply the mandatory ABAC access policy ----------------------------
  const visitorScope = await resolveVisitorScope();
  const access = resolveAssistantAccess({
    tier,
    publicChatEnabled,
    visitorScope,
  });

  if (!access.allowed) {
    const message =
      access.reason === "public-chat-disabled"
        ? "This group has not enabled its AI assistant for public chat."
        : access.reason === "visitors-disabled"
          ? "This group is not currently accepting visitor interactions."
          : "You don't have access to chat with this group's assistant.";
    return NextResponse.json({ error: message }, { status: 403 });
  }

  // ---- Rate-limit every non-exempt (outward-facing) caller ---------------
  if (!access.rateLimitExempt) {
    const limited = await rateLimit(
      `group-assistant:${groupId}:${rateLimitIdentity}`,
      ASSISTANT_RATE_LIMIT.limit,
      ASSISTANT_RATE_LIMIT.windowMs,
    );
    if (!limited.success) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(limited.resetMs / 1000)) },
        },
      );
    }
  }

  // ---- Validate the request body -----------------------------------------
  let body: AssistantChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, history } = body;
  if (!message || typeof message !== "string") {
    return NextResponse.json(
      { error: "message is required and must be a string" },
      { status: 400 },
    );
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `message exceeds maximum length of ${MAX_MESSAGE_LENGTH}` },
      { status: 400 },
    );
  }

  const sanitizedHistory: HistoryMessage[] = [];
  if (Array.isArray(history)) {
    for (const msg of history.slice(-MAX_HISTORY_LENGTH)) {
      if (
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string"
      ) {
        sanitizedHistory.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // ---- Build the persona-aware, scope-limited system prompt --------------
  const groupAgent = await getAgent(groupId);
  if (!groupAgent) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  const groupMeta = (groupAgent.metadata ?? {}) as Record<string, unknown>;
  const groupDescription =
    groupAgent.description ||
    (typeof groupMeta.bio === "string" ? groupMeta.bio : "") ||
    (typeof groupMeta.description === "string" ? groupMeta.description : "");

  let systemPrompt = buildGroupAssistantSystemPrompt(
    groupAgent.name,
    groupDescription,
    access.kgScope,
    direct.settings.customSoulMd,
    config.baseUrl,
  );

  // KG context is scoped to the caller's tier so member/private knowledge is
  // never surfaced to visitors. Best-effort: a KG outage yields no context.
  const { context: kgContext } = await buildContext(
    kgScopeTypeFor(access.kgScope),
    direct.directAgentId,
    KG_CONTEXT_MAX_CHARS,
  ).catch(() => ({ context: "", length: 0 }));

  if (kgContext) {
    systemPrompt += `\n\n## Knowledge\nThe following facts come from the group's knowledge graph. Use them to answer, but never reveal anything beyond what they contain:\n\n${kgContext}\n`;
  }

  // ---- Connector tools (owner/admin only) --------------------------------
  // Connectors can send/publish AS the group, so the act-tools are offered only
  // to the privileged tiers — the same boundary the /api/connectors route
  // enforces with `isGroupAdmin`. Lower tiers get a plain, tool-less completion.
  const canAct = tier === "owner" || tier === "admin";
  const connectorTools = buildGroupConnectorTools({ groupId, canAct });
  const actionTools = buildGroupActionToolset({ groupId, canAct });

  // Merge the connector toolset and the group-action toolset into one dispatch
  // surface for the model. Both are owner/admin-only; lower tiers get neither.
  const combinedTools = [
    ...(connectorTools?.tools ?? []),
    ...(actionTools?.tools ?? []),
  ];
  const actionToolNames = new Set((actionTools?.tools ?? []).map((tool) => tool.name));
  const executeCombinedTool =
    combinedTools.length > 0
      ? async (name: string, input: Record<string, unknown>): Promise<unknown> => {
          if (actionTools && actionToolNames.has(name)) {
            return actionTools.executeTool(name, input);
          }
          if (connectorTools) {
            return connectorTools.executeTool(name, input);
          }
          throw new Error(`Unknown tool "${name}".`);
        }
      : undefined;

  if (connectorTools) {
    systemPrompt += `\n\n## Connector Actions\nThis group has connectors you can operate on the operator's behalf. Use list_group_connectors first to see what is connected and which actions each provider supports. Only sync, save, publish, or send when the operator clearly asks for it; confirm recipients and content before sending email.\n`;
  }

  if (actionTools) {
    systemPrompt += `\n\n## Group Actions\nYou can create and manage things in this group on the operator's behalf: projects (with jobs/tasks), events, offerings, and documents, plus claiming/advancing jobs and tasks. Create resources only when the operator clearly asks; confirm the key details (title, date, price) before creating anything public-facing.\n`;
  }

  // ---- Answer natively ----------------------------------------------------
  try {
    const result = await nativeCloudChat({
      selectedModel: direct.settings.selectedModel,
      systemPrompt,
      history: sanitizedHistory,
      message,
      tools: combinedTools.length > 0 ? combinedTools : undefined,
      executeTool: executeCombinedTool,
    });

    return NextResponse.json({
      reply: result.reply || "...",
      model: result.model || direct.settings.selectedModel,
      scope: access.kgScope,
      assistantName: direct.isPersona ? undefined : groupAgent.name,
      actions: result.toolCalls,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach AI service";
    console.error("[group-assistant-chat] error:", errorMessage);
    return NextResponse.json(
      { error: `AI service error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
