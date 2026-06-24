/**
 * Tests for the pure sanitizer in `src/lib/group-assistant-settings.ts`.
 *
 * `get/saveGroupAssistantSettings` touch the DB and are covered by route-level
 * integration; here we lock down the sanitizer, which is the trust boundary for
 * everything read out of `agents.metadata.autobotSettings`.
 */

import { describe, expect, it } from "vitest";

import {
  sanitizeGroupAssistantSettings,
  DEFAULT_GROUP_ASSISTANT_MODEL,
} from "@/lib/group-assistant-settings";

describe("sanitizeGroupAssistantSettings", () => {
  it("returns safe defaults for non-object input", () => {
    const settings = sanitizeGroupAssistantSettings(null);
    expect(settings.selectedModel).toBe(DEFAULT_GROUP_ASSISTANT_MODEL);
    expect(settings.customSoulMd).toBe("");
    expect(settings.includedKgScopeIds).toEqual([]);
    expect(settings.publicChatEnabled).toBe(false);
    expect(settings.mcpToken).toBeNull();
  });

  it("trims the model selector and falls back when blank", () => {
    expect(
      sanitizeGroupAssistantSettings({ selectedModel: "  openai/gpt-4o  " })
        .selectedModel,
    ).toBe("openai/gpt-4o");
    expect(
      sanitizeGroupAssistantSettings({ selectedModel: "   " }).selectedModel,
    ).toBe(DEFAULT_GROUP_ASSISTANT_MODEL);
  });

  it("coerces publicChatEnabled to a strict boolean", () => {
    expect(sanitizeGroupAssistantSettings({ publicChatEnabled: true }).publicChatEnabled).toBe(true);
    expect(sanitizeGroupAssistantSettings({ publicChatEnabled: "true" }).publicChatEnabled).toBe(false);
    expect(sanitizeGroupAssistantSettings({ publicChatEnabled: 1 }).publicChatEnabled).toBe(false);
  });

  it("filters non-string and empty KG scope ids", () => {
    const settings = sanitizeGroupAssistantSettings({
      includedKgScopeIds: ["a", "", "  b  ", 5, null, "c"],
    });
    expect(settings.includedKgScopeIds).toEqual(["a", "b", "c"]);
  });

  it("drops a malformed mcpToken but keeps a well-formed one", () => {
    expect(
      sanitizeGroupAssistantSettings({ mcpToken: { token: "x" } }).mcpToken,
    ).toBeNull();

    const good = sanitizeGroupAssistantSettings({
      mcpToken: {
        token: "signed.payload",
        expiresAt: "2099-01-01T00:00:00.000Z",
        issuedAt: "2026-01-01T00:00:00.000Z",
        scopes: ["mcp:tools", 3],
      },
    });
    expect(good.mcpToken).not.toBeNull();
    expect(good.mcpToken?.token).toBe("signed.payload");
    expect(good.mcpToken?.scopes).toEqual(["mcp:tools"]);
  });
});
