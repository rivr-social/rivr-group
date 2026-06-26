/**
 * Assistant connector toolset (platform-evolution Wave 5 T5.3 — "assistant
 * read/act wiring").
 *
 * Exposes the group's connector lanes to the group's AI assistant as
 * Anthropic-style tools, so an authorized operator can ask the assistant to
 * sync, save, publish, or send through the group's configured connectors. The
 * assistant runs as the group's direct agent and INHERITS the group's
 * connectors, so every lane targets the group agent id.
 *
 * Security boundary (mirrors `/api/connectors`):
 *   - Connectors store provider credentials and can send/publish AS the group.
 *     The toolset is therefore offered ONLY to owner/admin callers. For every
 *     other tier (`member` / `visitor` / `anonymous`) {@link buildGroupConnectorTools}
 *     returns `null` and the chat route runs a plain, tool-less completion.
 *   - This is the assistant-side analogue of the route's `isGroupAdmin` gate:
 *     the human principal must be authorized; the assistant merely acts for them.
 *
 * The lanes themselves (`runConnector*`) are reused unchanged; this module only
 * adds the tool specs, dispatch, input validation, and the same
 * `lastSyncedAt`/`lastSyncError` bookkeeping the route performs.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { userConnectors } from "@/db/schema";
import type { NativeChatToolSpec } from "@/lib/ai/native-chat";
import { CONNECTOR_CATALOG, getConnectorDefinition } from "@/lib/connectors/catalog";
import { runConnectorSync, SYNCABLE_CONNECTOR_PROVIDERS } from "@/lib/connectors/notion-sync";
import { runConnectorItemSave, ITEM_SAVE_PROVIDERS } from "@/lib/connectors/gmail-save";
import { runConnectorEventPublish, EVENT_PUBLISH_PROVIDERS } from "@/lib/connectors/luma-publish";
import { runConnectorSendEmail, EMAIL_SEND_PROVIDERS } from "@/lib/connectors/gmail-send";

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const CONNECTOR_TOOL_LIST = "list_group_connectors" as const;
export const CONNECTOR_TOOL_SYNC = "sync_connector" as const;
export const CONNECTOR_TOOL_SAVE_EMAIL = "save_email_to_resources" as const;
export const CONNECTOR_TOOL_SEND_EMAIL = "send_email" as const;
export const CONNECTOR_TOOL_PUBLISH_EVENT = "publish_event" as const;

export const CONNECTOR_TOOL_NAMES = [
  CONNECTOR_TOOL_LIST,
  CONNECTOR_TOOL_SYNC,
  CONNECTOR_TOOL_SAVE_EMAIL,
  CONNECTOR_TOOL_SEND_EMAIL,
  CONNECTOR_TOOL_PUBLISH_EVENT,
] as const;

// ---------------------------------------------------------------------------
// Capability map (provider → which lanes it supports)
// ---------------------------------------------------------------------------

const SYNC_PROVIDERS = SYNCABLE_CONNECTOR_PROVIDERS as readonly string[];
const SAVE_PROVIDERS = ITEM_SAVE_PROVIDERS as readonly string[];
const PUBLISH_PROVIDERS = EVENT_PUBLISH_PROVIDERS as readonly string[];
const SEND_PROVIDERS = EMAIL_SEND_PROVIDERS as readonly string[];

/** Lane capabilities a single connector provider supports. */
export interface ConnectorCapabilities {
  sync: boolean;
  saveItem: boolean;
  publishEvent: boolean;
  sendEmail: boolean;
}

function capabilitiesFor(provider: string): ConnectorCapabilities {
  return {
    sync: SYNC_PROVIDERS.includes(provider),
    saveItem: SAVE_PROVIDERS.includes(provider),
    publishEvent: PUBLISH_PROVIDERS.includes(provider),
    sendEmail: SEND_PROVIDERS.includes(provider),
  };
}

// ---------------------------------------------------------------------------
// Bookkeeping (identical to the /api/connectors route)
// ---------------------------------------------------------------------------

/**
 * Stamp a connector's sync health after an assistant-driven lane run, so the
 * connections panel reflects assistant activity exactly as it reflects the
 * route's. A successful run clears the error; a failure records its message.
 */
async function recordConnectorRun(
  groupId: string,
  provider: string,
  error?: string,
): Promise<void> {
  const patch = error
    ? { lastSyncError: error, updatedAt: new Date() }
    : { lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() };
  await db
    .update(userConnectors)
    .set(patch)
    .where(
      and(
        eq(userConnectors.userAgentId, groupId),
        eq(userConnectors.provider, provider),
      ),
    );
}

// ---------------------------------------------------------------------------
// Input coercion helpers
// ---------------------------------------------------------------------------

function requireString(input: Record<string, unknown>, key: string, label: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function resolveProvider(input: Record<string, unknown>): string {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  if (!provider) throw new Error("A connector provider is required.");
  if (!getConnectorDefinition(provider)) {
    throw new Error(`Unknown connector provider "${provider}".`);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Toolset
// ---------------------------------------------------------------------------

/** A built connector toolset ready to hand to {@link nativeCloudChat}. */
export interface GroupConnectorToolset {
  tools: NativeChatToolSpec[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}

/** Inputs needed to build the assistant connector toolset. */
export interface BuildConnectorToolsInput {
  /** The controlling group agent id whose connectors the assistant inherits. */
  groupId: string;
  /**
   * Whether the calling principal may act on connectors (owner/admin only).
   * When false, no toolset is built and the assistant chats without tools.
   */
  canAct: boolean;
}

const TOOL_SPECS: NativeChatToolSpec[] = [
  {
    name: CONNECTOR_TOOL_LIST,
    description:
      "List the group's configured connectors and which actions each supports " +
      "(sync, save email, send email, publish event). Call this first to learn " +
      "what is connected before attempting any other connector action.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: CONNECTOR_TOOL_SYNC,
    description:
      "Import the latest items from a syncable connector (e.g. Notion) into the " +
      "group's Resources. Use list_group_connectors to confirm the provider " +
      "supports sync.",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Connector provider id, e.g. 'notion'." },
      },
      required: ["provider"],
      additionalProperties: false,
    },
  },
  {
    name: CONNECTOR_TOOL_SAVE_EMAIL,
    description:
      "Save a single Gmail message (by its Gmail message id) into the group's " +
      "Resources as a document.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The Gmail message id to save." },
        provider: { type: "string", description: "Optional provider id; defaults to 'gmail'." },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: CONNECTOR_TOOL_SEND_EMAIL,
    description:
      "Send a single email AS the group via the Gmail connector. Nothing is sent " +
      "until you call this with an explicit recipient, subject, and body. Confirm " +
      "the recipient and content with the operator before sending.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address (single address)." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body text." },
        html: { type: "boolean", description: "Send the body as HTML instead of plain text." },
        provider: { type: "string", description: "Optional provider id; defaults to 'gmail'." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: CONNECTOR_TOOL_PUBLISH_EVENT,
    description:
      "Publish one of the group's RIVR event resources OUT to Luma (one-way). " +
      "Re-publishing the same event updates the existing Luma event.",
    input_schema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "The RIVR event resource id to publish." },
        provider: { type: "string", description: "Optional provider id; defaults to 'luma'." },
      },
      required: ["resourceId"],
      additionalProperties: false,
    },
  },
];

/**
 * Build the owner/admin-only connector toolset for a group's assistant.
 *
 * @returns A toolset bound to `groupId`, or `null` when the caller is not
 *   authorized to act on connectors (member/visitor/anonymous).
 */
export function buildGroupConnectorTools(
  input: BuildConnectorToolsInput,
): GroupConnectorToolset | null {
  if (!input.canAct || !input.groupId) return null;
  const { groupId } = input;

  async function listConnectors(): Promise<unknown> {
    const rows = await db
      .select({
        provider: userConnectors.provider,
        accountEmail: userConnectors.accountEmail,
        accessToken: userConnectors.accessToken,
        lastSyncedAt: userConnectors.lastSyncedAt,
        lastSyncError: userConnectors.lastSyncError,
      })
      .from(userConnectors)
      .where(eq(userConnectors.userAgentId, groupId));

    return {
      connectors: rows.map((row) => {
        const definition = getConnectorDefinition(row.provider);
        return {
          provider: row.provider,
          label: definition?.label ?? row.provider,
          accountEmail: row.accountEmail,
          hasCredential: Boolean(row.accessToken),
          lastSyncedAt: row.lastSyncedAt ?? null,
          lastSyncError: row.lastSyncError ?? null,
          capabilities: capabilitiesFor(row.provider),
        };
      }),
      catalog: CONNECTOR_CATALOG.map((definition) => ({
        provider: definition.id,
        label: definition.label,
        capabilities: capabilitiesFor(definition.id),
      })),
    };
  }

  async function runLane(
    provider: string,
    lane: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      const result = await lane();
      await recordConnectorRun(groupId, provider);
      return { success: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connector action failed.";
      await recordConnectorRun(groupId, provider, message);
      throw new Error(message);
    }
  }

  async function executeTool(
    name: string,
    rawInput: Record<string, unknown>,
  ): Promise<unknown> {
    const input = rawInput ?? {};
    switch (name) {
      case CONNECTOR_TOOL_LIST:
        return listConnectors();

      case CONNECTOR_TOOL_SYNC: {
        const provider = resolveProvider(input);
        if (!SYNC_PROVIDERS.includes(provider)) {
          throw new Error(`Sync is not supported for the ${provider} connector.`);
        }
        return runLane(provider, () => runConnectorSync(groupId, provider));
      }

      case CONNECTOR_TOOL_SAVE_EMAIL: {
        const provider = typeof input.provider === "string" && input.provider.trim()
          ? resolveProvider(input)
          : SAVE_PROVIDERS[0];
        if (!SAVE_PROVIDERS.includes(provider)) {
          throw new Error(`Single-item save is not supported for the ${provider} connector.`);
        }
        const itemId = requireString(input, "itemId", "A Gmail message id");
        return runLane(provider, () => runConnectorItemSave(groupId, provider, itemId));
      }

      case CONNECTOR_TOOL_SEND_EMAIL: {
        const provider = typeof input.provider === "string" && input.provider.trim()
          ? resolveProvider(input)
          : SEND_PROVIDERS[0];
        if (!SEND_PROVIDERS.includes(provider)) {
          throw new Error(`Email send is not supported for the ${provider} connector.`);
        }
        const to = requireString(input, "to", "A recipient email address");
        const subject = requireString(input, "subject", "A subject");
        const body = typeof input.body === "string" ? input.body : "";
        const html = input.html === true;
        return runLane(provider, () =>
          runConnectorSendEmail(groupId, provider, { to, subject, body, html }),
        );
      }

      case CONNECTOR_TOOL_PUBLISH_EVENT: {
        const provider = typeof input.provider === "string" && input.provider.trim()
          ? resolveProvider(input)
          : PUBLISH_PROVIDERS[0];
        if (!PUBLISH_PROVIDERS.includes(provider)) {
          throw new Error(`Event publish is not supported for the ${provider} connector.`);
        }
        const resourceId = requireString(input, "resourceId", "An event resource id");
        return runLane(provider, () => runConnectorEventPublish(groupId, provider, resourceId));
      }

      default:
        throw new Error(`Unknown connector tool "${name}".`);
    }
  }

  return { tools: TOOL_SPECS, executeTool };
}
