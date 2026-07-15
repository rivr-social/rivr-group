/**
 * @fileoverview POST /api/builder/assistant — the agentic BUILDER ASSISTANT.
 *
 * The operator chats ("make the hero teal and add a donations page"); the
 * model runs the workspace-jailed tool loop (`makeBuilderToolset`:
 * list/read/write/delete + publish_site) over a server-held copy of the
 * site's files and the route returns the edited workspace so the builder UI
 * updates BEFORE anything goes live. `publish_site` persists through the SAME
 * owner-gated service path the Publish button uses — never a parallel write.
 *
 * Authority: {@link resolveSiteOwnerSubject} (remote-viewer-aware; a
 * `targetAgentId` names a group the caller must hold write access on — the
 * exact gate every other `/api/builder/*` route enforces).
 *
 * Model credential: a GROUP target uses the group's own encrypted assistant
 * key when configured (the D24 lane), falling back to the instance env
 * credential — identical to the group assistant chat route.
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  generateSiteFiles,
  getSitePublication,
  getSiteVersionFiles,
  publishSiteFiles,
  resolveSiteOwnerSubject,
} from "@/lib/builder/site-service";
import { makeBuilderToolset } from "@/lib/builder/assistant-tools";
import {
  DEFAULT_MODEL,
  nativeCloudChat,
  type HistoryMessage,
} from "@/lib/ai/native-chat";
import { resolveGroupDirectAgent } from "@/lib/group-assistant";
import { decryptSecret } from "@/lib/crypto/secret-box";
import { getAgent } from "@/lib/queries/agents";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_HISTORY_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;

interface BuilderAssistantBody {
  message?: string;
  history?: Array<{ role?: string; content?: string }>;
  targetAgentId?: string;
}

/** System prompt for the builder-assistant tool loop. */
function buildSystemPrompt(ownerName: string | null, isPublished: boolean): string {
  return [
    "You are the site-builder assistant on a RIVR instance. You edit a static",
    `site workspace${ownerName ? ` for "${ownerName}"` : ""} using the provided tools.`,
    "",
    "Rules:",
    "- Start by calling list_files, and read_file before editing anything.",
    "- write_file replaces the ENTIRE file — always write complete contents.",
    "- Keep the site's existing structure and style unless asked to change it.",
    "- NEVER call publish_site unless the operator explicitly asked to publish",
    "  or deploy in this conversation turn. Edits are previewed first.",
    "- Never announce an edit and stop: if you say you are changing a file,",
    "  complete the write_file call in this SAME turn.",
    isPublished
      ? "- A published version is live; publishing replaces it."
      : "- Nothing is published yet; the first publish makes the site live.",
    "- After finishing, summarize what changed in one or two sentences.",
  ].join("\n");
}

function sanitizeHistory(history: BuilderAssistantBody["history"]): HistoryMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (entry): entry is { role: string; content: string } =>
        !!entry &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string" &&
        entry.content.length > 0,
    )
    .slice(-MAX_HISTORY_LENGTH)
    .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.content }));
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: BuilderAssistantBody;
  try {
    body = (await request.json()) as BuilderAssistantBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: STATUS_BAD_REQUEST });
  }

  const subject = await resolveSiteOwnerSubject(body.targetAgentId);
  if ("error" in subject) {
    return NextResponse.json({ error: subject.error }, { status: subject.status });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `A message of 1–${MAX_MESSAGE_LENGTH} characters is required.` },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    const ownerId = subject.targetAgentId;

    // Base workspace: the live published snapshot when one exists, otherwise a
    // fresh generation from the owner's resources (same source as the Publish
    // button) so the assistant always has something concrete to edit.
    const publication = await getSitePublication(ownerId);
    let baseFiles =
      publication?.publishedVersionId != null
        ? await getSiteVersionFiles(ownerId, publication.publishedVersionId)
        : null;
    if (!baseFiles || Object.keys(baseFiles).length === 0) {
      baseFiles = await generateSiteFiles(ownerId, {});
    }

    // Group targets may carry their own encrypted assistant key (D24);
    // fall back to the instance env credential inside native-chat.
    let anthropicAuthToken: string | undefined;
    const isGroupTarget = ownerId !== subject.actorId;
    if (isGroupTarget) {
      try {
        const direct = await resolveGroupDirectAgent(ownerId);
        if (direct.settings.assistantApiKeyEnc) {
          anthropicAuthToken = decryptSecret(direct.settings.assistantApiKeyEnc) ?? undefined;
        }
      } catch {
        // Non-group or unconfigured target — env credential fallback.
      }
    }

    const ownerAgent = await getAgent(ownerId).catch(() => null);
    const toolset = makeBuilderToolset(baseFiles, async (files) => {
      const result = await publishSiteFiles(
        ownerId,
        files,
        "Published from the builder assistant",
      );
      return { versionNumber: result.version.versionNumber };
    });

    const chat = await nativeCloudChat({
      selectedModel: DEFAULT_MODEL,
      systemPrompt: buildSystemPrompt(
        ownerAgent?.name ?? null,
        publication?.publishedVersionId != null,
      ),
      history: sanitizeHistory(body.history),
      message,
      anthropicAuthToken,
      tools: toolset.tools,
      executeTool: toolset.executeTool,
    });

    const published = toolset.wasPublished();
    return NextResponse.json(
      {
        reply: chat.reply,
        files: toolset.getFiles(),
        changedPaths: toolset.getChangedPaths(),
        published,
        publication: published ? await getSitePublication(ownerId) : publication,
        toolCalls: chat.toolCalls ?? [],
      },
      { status: STATUS_OK, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "The builder assistant request failed.";
    // A missing model credential is a CONFIG state, not a server fault — 400
    // keeps error logs honest and tells the client it is actionable.
    const isCredentialGap = /credential|api key|oauth|anthropic_api_key/i.test(messageText);
    console.error("[api/builder/assistant] failed:", error);
    return NextResponse.json(
      { error: messageText },
      { status: isCredentialGap ? STATUS_BAD_REQUEST : STATUS_INTERNAL_ERROR },
    );
  }
}
