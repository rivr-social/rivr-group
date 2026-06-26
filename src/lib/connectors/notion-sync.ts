/**
 * @fileoverview Notion → Resources import sync for the group connector lane
 * (platform-evolution Wave 5 T5.2).
 *
 * Reads the `notion` credential stored on the agent's `user_connectors` row
 * (an internal-integration token, encrypted at rest by the secret-box envelope),
 * pulls the integration's accessible pages, and mirrors each one as a `document`
 * Resource owned by the target agent. Provenance is recorded in the mirrored
 * Resource's `metadata.source` block (the parachute-mirror lane contract,
 * {@link buildSourceBlock}), so re-syncs UPDATE in place rather than duplicate
 * and stale/echoed pulls are skipped via {@link shouldApplyRemoteUpdate}.
 *
 * Direction: import-only (one-way). Writeback (`syncMode: "two-way"`, T2.7) is
 * deliberately out of scope here. The connector stores a pasted integration
 * token — there is no OAuth refresh dance (unlike the person app's
 * NextAuth-account lane).
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { userConnectors } from "@/db/schema";
import { upsertMirroredDocument } from "@/lib/connectors/resource-mirror";
import { decryptSecret } from "@/lib/crypto/secret-box";

const NOTION_PROVIDER = "notion" as const;
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface NotionSearchPage {
  object: string;
  id: string;
  url?: string;
  public_url?: string | null;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

interface NotionSearchResponse {
  results?: NotionSearchPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface NotionBlock {
  type?: string;
  [key: string]: unknown;
}

interface NotionBlockChildrenResponse {
  results?: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Outcome counts returned to the caller (e.g. the connectors route). */
export interface NotionSyncResult {
  provider: "notion";
  imported: number;
  updated: number;
  skipped: number;
  message: string;
}

async function notionJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Notion API error (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/** Pulls the title out of a page's `title`-typed property, defaulting gracefully. */
export function extractTitle(page: NotionSearchPage): string {
  const properties = page.properties ?? {};
  for (const property of Object.values(properties)) {
    if (
      property &&
      typeof property === "object" &&
      !Array.isArray(property) &&
      (property as { type?: unknown }).type === "title" &&
      Array.isArray((property as { title?: unknown[] }).title)
    ) {
      const title = (property as { title: Array<{ plain_text?: string }> }).title
        .map((part) => part.plain_text ?? "")
        .join("")
        .trim();
      if (title) return title;
    }
  }
  return "Untitled Notion Page";
}

/** Concatenates rich-text runs into a plain string. */
function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((run) => (run && typeof run === "object" ? ((run as { plain_text?: string }).plain_text ?? "") : ""))
    .join("");
}

/**
 * Renders a flat list of top-level Notion blocks into Markdown. Notion's stable
 * (2022-06-28) API has no first-class markdown export, so we render the common
 * block types ourselves; unknown blocks are skipped rather than fabricated.
 */
export function blocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const type = block.type;
    if (!type) continue;
    const payload = block[type] as Record<string, unknown> | undefined;
    const text = payload ? richTextToPlain(payload.rich_text) : "";
    switch (type) {
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;
      case "to_do": {
        const checked = payload && (payload.checked as boolean);
        lines.push(`- [${checked ? "x" : " "}] ${text}`);
        break;
      }
      case "quote":
        lines.push(`> ${text}`);
        break;
      case "code":
        lines.push(`\`\`\`\n${text}\n\`\`\``);
        break;
      case "divider":
        lines.push("---");
        break;
      case "paragraph":
      default:
        if (text) lines.push(text);
        break;
    }
  }
  return lines.join("\n\n").trim();
}

async function fetchPageMarkdown(token: string, pageId: string): Promise<string> {
  const collected: NotionBlock[] = [];
  let cursor: string | null | undefined;
  // Cap pagination so a pathological page can't loop unbounded.
  for (let page = 0; page < 20; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : "?page_size=100";
    const response = await notionJson<NotionBlockChildrenResponse>(
      token,
      `/blocks/${encodeURIComponent(pageId)}/children${query}`,
    );
    if (Array.isArray(response.results)) collected.push(...response.results);
    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }
  return blocksToMarkdown(collected);
}

/**
 * Resolves and decrypts the Notion integration token stored for an agent, or
 * throws when the connector is absent.
 */
async function resolveNotionToken(targetAgentId: string): Promise<string> {
  const [connector] = await db
    .select({ accessToken: userConnectors.accessToken })
    .from(userConnectors)
    .where(and(eq(userConnectors.userAgentId, targetAgentId), eq(userConnectors.provider, NOTION_PROVIDER)))
    .limit(1);
  const token = decryptSecret(connector?.accessToken);
  if (!token) throw new Error("No Notion connector is configured for this agent.");
  return token;
}

/**
 * Imports the Notion integration's accessible pages into `document` Resources
 * owned by `targetAgentId`, recording provenance in each Resource's source
 * block. Idempotent: unchanged pages are skipped via last-write-wins.
 *
 * @param targetAgentId - The agent that owns the connector and the mirrored docs.
 * @param options.pageSize - Max pages to pull this run (1..100, default 25).
 * @throws {Error} When no Notion connector is configured or the API rejects us.
 */
export async function syncNotionConnector(
  targetAgentId: string,
  options: { pageSize?: number } = {},
): Promise<NotionSyncResult> {
  const token = await resolveNotionToken(targetAgentId);
  const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const search = await notionJson<NotionSearchResponse>(token, "/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: pageSize,
    }),
  });

  const pages = Array.isArray(search.results) ? search.results : [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const page of pages) {
    if (page.object !== "page") {
      skipped += 1;
      continue;
    }
    const markdown = await fetchPageMarkdown(token, page.id);
    if (!markdown) {
      skipped += 1;
      continue;
    }

    const outcome = await upsertMirroredDocument({
      ownerId: targetAgentId,
      provider: NOTION_PROVIDER,
      externalId: page.id,
      lane: "parachute-mirror",
      title: extractTitle(page),
      body: markdown,
      externalUrl: page.url ?? page.public_url ?? null,
      externalUpdatedAt: page.last_edited_time ?? null,
      tags: ["notion", "imported"],
      category: "Notion",
      description: "Imported from Notion",
    });
    if (outcome === "created") imported += 1;
    else if (outcome === "updated") updated += 1;
    else skipped += 1;
  }

  return {
    provider: NOTION_PROVIDER,
    imported,
    updated,
    skipped,
    message: `Imported ${imported}, updated ${updated}, skipped ${skipped} Notion page(s).`,
  };
}

/** Providers whose connector supports an on-demand `sync` action. */
export const SYNCABLE_CONNECTOR_PROVIDERS = [NOTION_PROVIDER] as const;

/**
 * Dispatches an on-demand connector sync for the given provider. Currently only
 * Notion is wired; other providers throw a clear "not supported" error so the
 * route surfaces an honest message rather than silently succeeding.
 */
export async function runConnectorSync(
  targetAgentId: string,
  provider: string,
): Promise<NotionSyncResult> {
  if (provider === NOTION_PROVIDER) {
    return syncNotionConnector(targetAgentId);
  }
  throw new Error(`Sync is not supported for the ${provider} connector yet.`);
}
