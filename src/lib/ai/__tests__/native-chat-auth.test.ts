/**
 * Unit tests for the Anthropic credential-type branching in `@/lib/ai/native-chat`.
 *
 * A group may supply either a Claude (Max) OAuth token (`sk-ant-oat…`) or a
 * plain Anthropic API key (`sk-ant-api…`). The two authenticate DIFFERENTLY:
 *   - OAuth  → `Authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`
 *              + the CLAUDE_CODE_IDENTITY leading system block.
 *   - API key → `x-api-key: …`, NO oauth beta header, NO identity block.
 *
 * Sending the wrong combination is a hard auth failure, so these classifiers are
 * the load-bearing switch. Pure functions, no network/DB — run with
 * `pnpm test:unit`.
 */
import { describe, it, expect } from "vitest";
import {
  isOAuthAnthropicToken,
  buildAnthropicRequestHeaders,
  buildAnthropicSystemBlocks,
  ANTHROPIC_VERSION,
  ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_IDENTITY,
} from "@/lib/ai/native-chat";

const OAUTH_TOKEN = "sk-ant-oat01-abc123def456";
const API_KEY = "sk-ant-api03-xyz789uvw012";

describe("isOAuthAnthropicToken", () => {
  it("classifies an sk-ant-oat token as OAuth", () => {
    expect(isOAuthAnthropicToken(OAUTH_TOKEN)).toBe(true);
  });

  it("classifies a plain sk-ant-api key as NOT OAuth", () => {
    expect(isOAuthAnthropicToken(API_KEY)).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isOAuthAnthropicToken(`  ${OAUTH_TOKEN}  `)).toBe(true);
    expect(isOAuthAnthropicToken(`  ${API_KEY}  `)).toBe(false);
  });

  it("returns false for empty / non-string input", () => {
    expect(isOAuthAnthropicToken("")).toBe(false);
    // @ts-expect-error — defensive: guards against a non-string at runtime.
    expect(isOAuthAnthropicToken(undefined)).toBe(false);
  });
});

describe("buildAnthropicRequestHeaders", () => {
  it("uses Bearer + oauth beta for an OAuth token", () => {
    const headers = buildAnthropicRequestHeaders(OAUTH_TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses x-api-key with NO Authorization/oauth-beta for an API key", () => {
    const headers = buildAnthropicRequestHeaders(API_KEY);
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("buildAnthropicSystemBlocks", () => {
  it("prepends the CLAUDE_CODE_IDENTITY block for OAuth tokens", () => {
    const blocks = buildAnthropicSystemBlocks("Operator prompt", true);
    expect(blocks).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: "Operator prompt" },
    ]);
  });

  it("omits the identity block for API keys (operator prompt only)", () => {
    const blocks = buildAnthropicSystemBlocks("Operator prompt", false);
    expect(blocks).toEqual([{ type: "text", text: "Operator prompt" }]);
  });

  it("returns an empty list for an API key with no operator prompt", () => {
    expect(buildAnthropicSystemBlocks(null, false)).toEqual([]);
  });

  it("still emits the identity block for OAuth with no operator prompt", () => {
    expect(buildAnthropicSystemBlocks(null, true)).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
    ]);
  });
});
