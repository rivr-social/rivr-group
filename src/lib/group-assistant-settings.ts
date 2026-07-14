/**
 * Group-assistant settings — the `autobotSettings` blob stored on a group's
 * direct agent (or its autobot-enabled persona).
 *
 * This is the group-app analogue of the person app's `autobot-user-settings`,
 * trimmed to what a sovereign group's AI assistant actually needs:
 *   - which model the assistant runs (selectedModel),
 *   - an operator-authored persona/soul prompt (customSoulMd),
 *   - the KG scope ids the assistant may draw context from
 *     (includedKgScopeIds), and
 *   - a lazily-provisioned, scoped MCP token (mcpToken).
 *
 * Person-only concerns (digital twin, voice cloning, GPU providers) are
 * deliberately omitted — they are not part of the group assistant surface.
 *
 * Settings live in `agents.metadata.autobotSettings` (no migration), mirroring
 * the person app's storage key so the two implementations stay conceptually
 * aligned.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { signPackedPayload } from "@/lib/federation-remote-session";

/** Storage key on `agents.metadata`. Matches the person app for parity. */
export const GROUP_ASSISTANT_SETTINGS_KEY = "autobotSettings";

/** Default model selector for a freshly-configured group assistant. */
export const DEFAULT_GROUP_ASSISTANT_MODEL = "anthropic/claude-sonnet-4-6";

/** Auto-provisioned scoped MCP token stored alongside settings. */
export interface AssistantMcpToken {
  token: string;
  expiresAt: string;
  scopes: string[];
  issuedAt: string;
}

export interface GroupAssistantSettings {
  /** Rivr model selector, e.g. "anthropic/claude-sonnet-4-6". */
  selectedModel: string;
  /** Operator-authored persona/soul prompt prepended to the system prompt. */
  customSoulMd: string;
  /** KG scope ids the assistant may pull context from. */
  includedKgScopeIds: string[];
  /** Whether the assistant is exposed to non-admin visitors at all. */
  publicChatEnabled: boolean;
  /** Auto-provisioned MCP token for this agent. Lazily created on first access. */
  mcpToken?: AssistantMcpToken | null;
  /**
   * Admin-supplied Anthropic credential (an API key or Claude Code OAuth token)
   * stored ENCRYPTED via `encryptSecret` (an `enc:v1:…` envelope). When present,
   * the assistant uses the group's own key for Anthropic models instead of the
   * instance's shared credential. Server-side only — never sent to any client.
   */
  assistantApiKeyEnc?: string | null;
  updatedAt?: string;
}

const DEFAULT_SETTINGS: GroupAssistantSettings = {
  selectedModel: DEFAULT_GROUP_ASSISTANT_MODEL,
  customSoulMd: "",
  includedKgScopeIds: [],
  publicChatEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an arbitrary metadata blob into a well-formed settings object. */
export function sanitizeGroupAssistantSettings(
  input: unknown,
): GroupAssistantSettings {
  const record = isRecord(input) ? input : {};

  const selectedModel =
    typeof record.selectedModel === "string" && record.selectedModel.trim()
      ? record.selectedModel.trim()
      : DEFAULT_SETTINGS.selectedModel;

  const customSoulMd =
    typeof record.customSoulMd === "string" ? record.customSoulMd.trim() : "";

  const includedKgScopeIds = Array.isArray(record.includedKgScopeIds)
    ? record.includedKgScopeIds
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => value.trim())
    : [];

  const publicChatEnabled = record.publicChatEnabled === true;

  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt
      ? record.updatedAt
      : undefined;

  const mcpToken = sanitizeMcpToken(record.mcpToken);

  const assistantApiKeyEnc =
    typeof record.assistantApiKeyEnc === "string" &&
    record.assistantApiKeyEnc.trim().length > 0
      ? record.assistantApiKeyEnc
      : null;

  return {
    selectedModel,
    customSoulMd,
    includedKgScopeIds,
    publicChatEnabled,
    mcpToken,
    assistantApiKeyEnc,
    updatedAt,
  };
}

function sanitizeMcpToken(input: unknown): AssistantMcpToken | null {
  if (!isRecord(input)) return null;
  const token = typeof input.token === "string" ? input.token : null;
  const expiresAt = typeof input.expiresAt === "string" ? input.expiresAt : null;
  const issuedAt = typeof input.issuedAt === "string" ? input.issuedAt : null;
  const scopes = Array.isArray(input.scopes)
    ? input.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (!token || !expiresAt || !issuedAt) return null;
  return { token, expiresAt, scopes, issuedAt };
}

// ---------------------------------------------------------------------------
// MCP token provisioning
// ---------------------------------------------------------------------------

const MCP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MCP_TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000; // refresh with <1d left
const MCP_TOKEN_SCOPES = [
  "mcp:tools",
  "profile:read",
  "group:write",
  "federation:write",
];

/**
 * Auto-provision a scoped MCP token for a group's direct agent. The token is
 * a signed packed payload identical in shape to the person app's, so the same
 * MCP server validation applies.
 */
export function provisionAssistantMcpToken(agentId: string): AssistantMcpToken {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const now = Date.now();
  const payload = {
    type: "rivr_mcp_token",
    actorId: agentId,
    controllerId: agentId,
    actorType: "group",
    issuer: baseUrl,
    audience: baseUrl,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MCP_TOKEN_TTL_MS).toISOString(),
    scopes: MCP_TOKEN_SCOPES,
  };

  return {
    token: signPackedPayload(payload as unknown as Record<string, unknown>),
    expiresAt: payload.expiresAt,
    scopes: MCP_TOKEN_SCOPES,
    issuedAt: payload.issuedAt,
  };
}

function isMcpTokenValid(mcpToken: AssistantMcpToken | null | undefined): boolean {
  if (!mcpToken?.token || !mcpToken.expiresAt) return false;
  const expiresAt = Date.parse(mcpToken.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > Date.now() + MCP_TOKEN_REFRESH_BUFFER_MS;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Load the assistant settings for an agent (group direct agent or persona),
 * auto-provisioning the MCP token when missing/expired.
 */
export async function getGroupAssistantSettings(
  agentId: string,
): Promise<GroupAssistantSettings> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  const settings = sanitizeGroupAssistantSettings(
    metadata[GROUP_ASSISTANT_SETTINGS_KEY],
  );

  if (!isMcpTokenValid(settings.mcpToken)) {
    const mcpToken = provisionAssistantMcpToken(agentId);
    settings.mcpToken = mcpToken;
    // Fire-and-forget persistence; never block resolution on the write.
    saveGroupAssistantSettings(agentId, { mcpToken }).catch(() => {});
  }

  return settings;
}

/**
 * Merge a partial settings patch into the agent's stored assistant settings.
 *
 * @throws {Error} When `agentId` is empty.
 */
export async function saveGroupAssistantSettings(
  agentId: string,
  patch: Partial<GroupAssistantSettings>,
): Promise<GroupAssistantSettings> {
  if (!agentId) {
    throw new Error("saveGroupAssistantSettings: agentId is required.");
  }

  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  const current = sanitizeGroupAssistantSettings(
    metadata[GROUP_ASSISTANT_SETTINGS_KEY],
  );
  const next = sanitizeGroupAssistantSettings({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });

  await db
    .update(agents)
    .set({
      metadata: {
        ...metadata,
        [GROUP_ASSISTANT_SETTINGS_KEY]: next,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  return next;
}
