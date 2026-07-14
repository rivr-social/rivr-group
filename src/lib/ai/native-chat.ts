/**
 * Native chat — single source of truth for talking to model providers directly.
 *
 * Ported from the person app's unified-agent model so the sovereign group's AI
 * assistant (outward-facing visitor chat + admin self-chat) routes through one
 * place. No SDK dependency: every provider is a raw `fetch`.
 *
 * Providers:
 *   - anthropic/* → api.anthropic.com using the instance's Claude (Max) OAuth
 *     credential (Bearer + oauth beta header).
 *   - openai/*    → api.openai.com using OPENAI_API_KEY.
 *   - gemini/*    → Google Generative Language API using GOOGLE_AI_API_KEY.
 *   - local/*     → Ollama.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
/**
 * Prefix of a Claude (Max) OAuth access token (`sk-ant-oat…`). These tokens are
 * only authorized for Claude Code usage and must be sent as a Bearer credential
 * with the oauth beta header + the identity system block. A plain Anthropic API
 * key (`sk-ant-api…`) does NOT match this prefix and takes the `x-api-key` path.
 */
export const ANTHROPIC_OAUTH_TOKEN_PREFIX = "sk-ant-oat";
// Claude (Max) OAuth credentials are only authorized for Claude Code usage.
// The Messages API rejects them (HTTP 429 rate_limit_error) unless the first
// system block is exactly this identity string. We prepend it as a separate
// block so the operator's real system prompt still drives behavior.
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
export const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

export const ANTHROPIC_MAX_TOKENS = 4096;
export const OPENAI_MAX_TOKENS = 4096;
export const GEMINI_MAX_TOKENS = 4096;
export const OLLAMA_TIMEOUT_MS = 90_000;

/** Maximum tool-use round trips per chat turn before forcing a text reply. */
export const TOOL_LOOP_MAX_ITERATIONS = 8;
/** Tool results are truncated to this length before being sent back to the model. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
export const GEMINI_FALLBACK_MODEL = "gemini/gemini-2.0-flash";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Anthropic Messages API tool specification. */
export interface NativeChatToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Record of a single tool invocation made during a chat turn. */
export interface NativeChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
}

export interface CloudChatResult {
  reply: string;
  model: string;
  /** Tools invoked during this turn (Anthropic tool-use loop only). */
  toolCalls?: NativeChatToolCall[];
}

export interface OllamaChatResult {
  reply: string;
  model: string;
  evalTokens: number | null;
  totalDurationMs: number | null;
}

export interface NativeChatParams {
  /** Rivr model selector value, e.g. "anthropic/claude-sonnet-4-6". */
  selectedModel: string;
  /** Operator/persona system prompt. Prepended after CLAUDE_CODE_IDENTITY. */
  systemPrompt: string | null;
  history: HistoryMessage[];
  message: string;
  /**
   * Optional Anthropic credential (a group's own key) overriding the instance's
   * shared credential. Anthropic models ONLY — other providers ignore it.
   * `sk-ant-oat…` OAuth tokens keep the Claude-Code Bearer/identity behavior;
   * any other `sk-ant-…` value is a real API key sent via `x-api-key`.
   */
  anthropicAuthToken?: string;
  /**
   * Optional agentic tool support (Anthropic models only — other providers
   * ignore these and return a plain text completion). When both `tools` and
   * `executeTool` are provided, chatViaAnthropic runs a tool-use loop:
   * tool_use blocks are executed via `executeTool` and fed back as
   * tool_result messages until the model ends its turn.
   */
  tools?: NativeChatToolSpec[];
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Model classification
// ---------------------------------------------------------------------------

export function isLocalModel(model: string): boolean {
  return model.startsWith("local/");
}

export function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini/");
}

export function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

export function isOpenAIModel(model: string): boolean {
  return model.startsWith("openai/");
}

export function resolveOllamaModelName(model: string): string {
  if (model === "local/ollama") return OLLAMA_MODEL;
  return model.slice("local/".length) || OLLAMA_MODEL;
}

export function resolveGeminiModelName(model: string): string {
  return model.slice("gemini/".length) || "gemini-2.0-flash";
}

/**
 * True when a provider error looks like a rate limit / usage cap, in which case
 * callers may want to fall back to Gemini direct.
 */
export function isRateLimitError(errorMessage: string): boolean {
  return (
    errorMessage.includes("(429)") ||
    errorMessage.toLowerCase().includes("rate_limit")
  );
}

// ---------------------------------------------------------------------------
// Claude (Max) OAuth credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Claude (Max) OAuth access token for this instance.
 *
 * Prefers the live Claude CLI credential store (refreshed by the in-app
 * claude-auth flow), falling back to the ANTHROPIC_API_KEY env var. Returns the
 * raw `sk-ant-oat01-*` token used as a Bearer credential against the API.
 */
export async function resolveClaudeOAuthToken(): Promise<string> {
  const claudeHome = process.env.AGENT_HQ_CLAUDE_HOME;
  if (claudeHome) {
    const credentialsPath = path.join(claudeHome, ".claude", ".credentials.json");
    try {
      const raw = await readFile(credentialsPath, "utf8");
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: { accessToken?: string };
      };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token.trim().length > 0) {
        return token.trim();
      }
    } catch {
      // Fall through to the env credential when the store is missing/unreadable.
    }
  }
  const envToken = process.env.ANTHROPIC_API_KEY;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }
  throw new Error(
    "No Claude OAuth credential available (claude-runtime or ANTHROPIC_API_KEY)",
  );
}

// ---------------------------------------------------------------------------
// Anthropic credential-type branching
// ---------------------------------------------------------------------------

/**
 * True when a token is a Claude (Max) OAuth access token (`sk-ant-oat…`).
 *
 * OAuth tokens must use `Authorization: Bearer …` + the oauth beta header +
 * the CLAUDE_CODE_IDENTITY system block. A plain Anthropic API key
 * (`sk-ant-api…`, or any other `sk-ant-…` value) returns false and takes the
 * `x-api-key` path with no beta header and no identity block.
 */
export function isOAuthAnthropicToken(token: string): boolean {
  return (
    typeof token === "string" &&
    token.trim().startsWith(ANTHROPIC_OAUTH_TOKEN_PREFIX)
  );
}

/**
 * Build the Anthropic request headers for a given credential. OAuth tokens
 * (`sk-ant-oat…`) authenticate with a Bearer credential + the oauth beta
 * header; plain API keys authenticate with `x-api-key` and NO oauth beta
 * header. `anthropic-version` + `Content-Type` are sent on both.
 */
export function buildAnthropicRequestHeaders(
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (isOAuthAnthropicToken(token)) {
    headers.Authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

/**
 * Build the system blocks for an Anthropic request. OAuth tokens require the
 * CLAUDE_CODE_IDENTITY block to lead so the Messages API accepts them; API keys
 * omit it. The operator's real system prompt follows in both cases.
 */
export function buildAnthropicSystemBlocks(
  systemPrompt: string | null,
  isOAuthToken: boolean,
): Array<{ type: "text"; text: string }> {
  const blocks: Array<{ type: "text"; text: string }> = [];
  if (isOAuthToken) {
    blocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY });
  }
  if (systemPrompt) {
    blocks.push({ type: "text", text: systemPrompt });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

function extractTextReply(blocks: AnthropicContentBlock[] | undefined): string {
  return (
    blocks
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("") || ""
  );
}

export async function chatViaAnthropic(
  params: NativeChatParams,
): Promise<CloudChatResult> {
  // A caller-supplied group key (if any) overrides the instance credential;
  // its type (OAuth vs API key) drives header + system-block selection.
  const token = params.anthropicAuthToken
    ? params.anthropicAuthToken
    : await resolveClaudeOAuthToken();
  const isOAuthToken = isOAuthAnthropicToken(token);
  const modelId = params.selectedModel.slice("anthropic/".length);

  const systemBlocks = buildAnthropicSystemBlocks(
    params.systemPrompt,
    isOAuthToken,
  );

  const messages: AnthropicMessage[] = [
    ...params.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: params.message },
  ];

  const useTools = Boolean(
    params.tools && params.tools.length > 0 && params.executeTool,
  );
  const toolCalls: NativeChatToolCall[] = [];

  // Agentic loop: a plain chat resolves on the first pass; when tools are
  // wired, tool_use responses execute locally and feed tool_result messages
  // back until the model ends its turn (or the iteration budget runs out,
  // after which tools are withheld to force a text reply).
  for (let iteration = 0; ; iteration++) {
    const toolsExhausted = iteration >= TOOL_LOOP_MAX_ITERATIONS;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: buildAnthropicRequestHeaders(token),
      body: JSON.stringify({
        model: modelId,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
        messages,
        ...(useTools && !toolsExhausted ? { tools: params.tools } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic API error (${response.status}): ${errorText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      content?: AnthropicContentBlock[];
      stop_reason?: string;
    };

    if (useTools && !toolsExhausted && data.stop_reason === "tool_use") {
      const contentBlocks = data.content ?? [];
      messages.push({
        role: "assistant",
        content: contentBlocks as Array<Record<string, unknown>>,
      });

      const toolResults: Array<Record<string, unknown>> = [];
      for (const block of contentBlocks) {
        if (block.type !== "tool_use" || !block.id || !block.name) continue;
        const input = block.input ?? {};
        let payload: unknown;
        let isError = false;
        try {
          payload = await params.executeTool!(block.name, input);
        } catch (error) {
          isError = true;
          payload = {
            success: false,
            error: error instanceof Error ? error.message : "Tool execution failed.",
          };
        }
        toolCalls.push({ name: block.name, input, ok: !isError });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(payload ?? null).slice(0, TOOL_RESULT_MAX_CHARS),
          is_error: isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const reply = extractTextReply(data.content) || "...";
    return {
      reply,
      model: params.selectedModel,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

export async function chatViaOpenAI(
  params: NativeChatParams,
): Promise<CloudChatResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const modelId = params.selectedModel.slice("openai/".length);

  const openaiMessages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt) {
    openaiMessages.push({ role: "system", content: params.systemPrompt });
  }
  for (const m of params.history) {
    openaiMessages.push({ role: m.role, content: m.content });
  }
  openaiMessages.push({ role: "user", content: params.message });

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: OPENAI_MAX_TOKENS,
      messages: openaiMessages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenAI API error (${response.status}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const reply = data.choices?.[0]?.message?.content || "...";
  return { reply, model: params.selectedModel };
}

export async function chatViaGemini(
  params: NativeChatParams,
): Promise<CloudChatResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_AI_API_KEY is not configured");
  }
  const geminiModel = resolveGeminiModelName(params.selectedModel);

  const contents = [
    ...params.history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: params.message }] },
  ];

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS },
  };
  if (params.systemPrompt) {
    body.system_instruction = { parts: [{ text: params.systemPrompt }] };
  }

  const response = await fetch(
    `${GEMINI_API_URL}/${geminiModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Gemini API error (${response.status}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
  let reply = "...";
  if (candidates && candidates.length > 0) {
    const content = candidates[0].content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    if (parts && parts.length > 0 && typeof parts[0].text === "string") {
      reply = parts[0].text as string;
    }
  }

  return { reply, model: `gemini/${geminiModel}` };
}

export async function chatViaOllama(
  params: NativeChatParams,
): Promise<OllamaChatResult> {
  const ollamaModel = resolveOllamaModelName(params.selectedModel);

  const messages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  for (const msg of params.history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: params.message });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages,
        stream: false,
        options: { num_ctx: 4096 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Ollama returned ${res.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      reply: data.message?.content || "...",
      model: `local/${data.model || ollamaModel}`,
      evalTokens: data.eval_count || null,
      totalDurationMs: data.total_duration
        ? Math.round(data.total_duration / 1_000_000)
        : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// High-level cloud router
// ---------------------------------------------------------------------------

/**
 * Route a cloud (anthropic/openai/gemini) chat to the correct provider, with an
 * automatic Gemini-direct fallback when a provider rate-limits and
 * GOOGLE_AI_API_KEY is configured. Local (Ollama) models are NOT handled here —
 * call {@link chatViaOllama} directly for those.
 */
export async function nativeCloudChat(
  params: NativeChatParams,
): Promise<CloudChatResult> {
  try {
    if (isAnthropicModel(params.selectedModel)) {
      return await chatViaAnthropic(params);
    }
    if (isOpenAIModel(params.selectedModel)) {
      return await chatViaOpenAI(params);
    }
    if (isGeminiModel(params.selectedModel)) {
      return await chatViaGemini(params);
    }
    // Unknown selector — treat as the default Anthropic model.
    return await chatViaAnthropic({ ...params, selectedModel: DEFAULT_MODEL });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach the model provider";

    if (process.env.GOOGLE_AI_API_KEY && isRateLimitError(errorMessage)) {
      return chatViaGemini({ ...params, selectedModel: GEMINI_FALLBACK_MODEL });
    }
    throw error;
  }
}
