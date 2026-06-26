/**
 * @fileoverview Gmail on-demand single-item save for the group connector lane
 * (platform-evolution Wave 2 T2.6 — "Gmail on-demand single-item save only").
 *
 * Unlike the Notion lane, Gmail does NOT run a bulk import loop: the user picks
 * one message and saves it. Given a Gmail message id, this fetches that message
 * via the Gmail REST API using the agent's stored access token (encrypted at
 * rest), renders it to Markdown, and mirrors it as a `document` Resource via the
 * shared {@link upsertMirroredDocument} helper (on-demand lane). Re-saving the
 * same message updates in place rather than duplicating.
 *
 * The group lane stores a pasted OAuth access token (no refresh dance here — the
 * refresh-capable path is the separate `groupConnections` Google Workspace
 * lane). An expired token surfaces an honest "reconnect" error.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { userConnectors } from "@/db/schema";
import { upsertMirroredDocument, type MirrorOutcome } from "@/lib/connectors/resource-mirror";
import { decryptSecret } from "@/lib/crypto/secret-box";

const GMAIL_PROVIDER = "gmail" as const;
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Outcome of a single Gmail save. */
export interface GmailSaveResult {
  provider: "gmail";
  outcome: MirrorOutcome;
  messageId: string;
  subject: string;
}

/** Decodes a Gmail base64url body segment to a UTF-8 string. */
function decodeBody(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const match = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

/** Very small HTML→text reduction for the fallback when no text/plain part exists. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Walks the MIME tree and returns the best body text: prefers `text/plain`,
 * falling back to a reduced `text/html`.
 */
export function extractBodyText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  let plain = "";
  let html = "";
  const walk = (part: GmailPart) => {
    const mime = part.mimeType ?? "";
    if (mime === "text/plain" && !plain) plain = decodeBody(part.body?.data);
    else if (mime === "text/html" && !html) html = decodeBody(part.body?.data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  if (plain.trim()) return plain.trim();
  if (html.trim()) return htmlToText(html);
  return "";
}

/** Renders a Gmail message into a Markdown document with a small header block. */
export function renderGmailMarkdown(message: GmailMessage): { subject: string; markdown: string } {
  const headers = message.payload?.headers;
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const from = headerValue(headers, "From");
  const to = headerValue(headers, "To");
  const date = headerValue(headers, "Date");
  const body = extractBodyText(message.payload) || (message.snippet ?? "");

  const lines = [`# ${subject}`, ""];
  if (from) lines.push(`**From:** ${from}`);
  if (to) lines.push(`**To:** ${to}`);
  if (date) lines.push(`**Date:** ${date}`);
  lines.push("", "---", "", body);
  return { subject, markdown: lines.join("\n").trim() };
}

/** Resolves and decrypts the Gmail access token stored for an agent. */
export async function resolveGmailToken(targetAgentId: string): Promise<string> {
  const [connector] = await db
    .select({ accessToken: userConnectors.accessToken })
    .from(userConnectors)
    .where(and(eq(userConnectors.userAgentId, targetAgentId), eq(userConnectors.provider, GMAIL_PROVIDER)))
    .limit(1);
  const token = decryptSecret(connector?.accessToken);
  if (!token) throw new Error("No Gmail connector is configured for this agent.");
  return token;
}

/**
 * Fetches a single Gmail message and mirrors it as a `document` Resource owned
 * by `targetAgentId`.
 *
 * @param targetAgentId - Agent that owns the connector and the saved Resource.
 * @param messageId - Gmail message id to save.
 * @throws {Error} When no connector is configured, the token expired (401), or
 *                 the Gmail API otherwise rejects the request.
 */
export async function saveGmailMessage(
  targetAgentId: string,
  messageId: string,
): Promise<GmailSaveResult> {
  const trimmedId = messageId.trim();
  if (!trimmedId) throw new Error("A Gmail message id is required.");
  const token = await resolveGmailToken(targetAgentId);

  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(trimmedId)}?format=full`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 401) {
    throw new Error("Gmail access expired. Reconnect the Gmail connector.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gmail API error (${response.status}): ${detail.slice(0, 300)}`);
  }

  const message = (await response.json()) as GmailMessage;
  const { subject, markdown } = renderGmailMarkdown(message);
  const externalUpdatedAt = message.internalDate
    ? new Date(Number.parseInt(message.internalDate, 10))
    : null;

  const outcome = await upsertMirroredDocument({
    ownerId: targetAgentId,
    provider: GMAIL_PROVIDER,
    externalId: message.id,
    lane: "on-demand",
    title: subject,
    body: markdown,
    externalUrl: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
    externalUpdatedAt,
    tags: ["gmail", "imported"],
    category: "Gmail",
    description: "Saved from Gmail",
  });

  return { provider: GMAIL_PROVIDER, outcome, messageId: message.id, subject };
}

/** Providers whose connector supports an on-demand single-item save. */
export const ITEM_SAVE_PROVIDERS = [GMAIL_PROVIDER] as const;

/**
 * Dispatches an on-demand single-item save for the given provider. Currently
 * only Gmail is wired; other providers throw a clear "not supported" error.
 */
export async function runConnectorItemSave(
  targetAgentId: string,
  provider: string,
  itemId: string,
): Promise<GmailSaveResult> {
  if (provider === GMAIL_PROVIDER) {
    return saveGmailMessage(targetAgentId, itemId);
  }
  throw new Error(`Single-item save is not supported for the ${provider} connector.`);
}
