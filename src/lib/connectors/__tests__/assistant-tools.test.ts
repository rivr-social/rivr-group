import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state: connector rows the mocked db returns, and the update spy used
// to assert lastSyncedAt/lastSyncError bookkeeping.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  updateSet: vi.fn(),
}));

const lanes = vi.hoisted(() => ({
  sync: vi.fn(async () => ({ imported: 3 })),
  save: vi.fn(async () => ({ resourceId: "res-1" })),
  publish: vi.fn(async () => ({ lumaEventId: "evt-1" })),
  send: vi.fn(async () => ({ messageId: "msg-1" })),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => dbState.rows) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        dbState.updateSet(patch);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  },
}));

vi.mock("@/lib/connectors/notion-sync", () => ({
  runConnectorSync: lanes.sync,
  SYNCABLE_CONNECTOR_PROVIDERS: ["notion"] as const,
}));
vi.mock("@/lib/connectors/gmail-save", () => ({
  runConnectorItemSave: lanes.save,
  ITEM_SAVE_PROVIDERS: ["gmail"] as const,
}));
vi.mock("@/lib/connectors/luma-publish", () => ({
  runConnectorEventPublish: lanes.publish,
  EVENT_PUBLISH_PROVIDERS: ["luma"] as const,
}));
vi.mock("@/lib/connectors/gmail-send", () => ({
  runConnectorSendEmail: lanes.send,
  EMAIL_SEND_PROVIDERS: ["gmail"] as const,
}));

import {
  buildGroupConnectorTools,
  CONNECTOR_TOOL_NAMES,
  CONNECTOR_TOOL_LIST,
  CONNECTOR_TOOL_SYNC,
  CONNECTOR_TOOL_SAVE_EMAIL,
  CONNECTOR_TOOL_SEND_EMAIL,
  CONNECTOR_TOOL_PUBLISH_EVENT,
} from "@/lib/connectors/assistant-tools";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  dbState.rows = [];
  dbState.updateSet.mockClear();
  lanes.sync.mockClear();
  lanes.save.mockClear();
  lanes.publish.mockClear();
  lanes.send.mockClear();
});

describe("buildGroupConnectorTools — authorization gate", () => {
  it("returns null when the caller may not act (member/visitor/anonymous)", () => {
    expect(buildGroupConnectorTools({ groupId: GROUP_ID, canAct: false })).toBeNull();
  });

  it("returns null when no groupId is supplied", () => {
    expect(buildGroupConnectorTools({ groupId: "", canAct: true })).toBeNull();
  });

  it("returns a toolset for an authorized owner/admin caller", () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true });
    expect(toolset).not.toBeNull();
    expect(typeof toolset!.executeTool).toBe("function");
  });
});

describe("buildGroupConnectorTools — tool specs", () => {
  it("exposes exactly the five connector tools by name", () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    const names = toolset.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...CONNECTOR_TOOL_NAMES].sort());
  });

  it("each tool spec has an object input_schema", () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    for (const tool of toolset.tools) {
      expect(tool.input_schema).toMatchObject({ type: "object" });
      expect(typeof tool.description).toBe("string");
    }
  });
});

describe("executeTool — list_group_connectors", () => {
  it("returns the group's connectors with per-provider capabilities and no raw token", async () => {
    dbState.rows = [
      {
        provider: "notion",
        accountEmail: "ops@group.example",
        accessToken: "secret-token",
        lastSyncedAt: null,
        lastSyncError: null,
      },
    ];
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    const result = (await toolset.executeTool(CONNECTOR_TOOL_LIST, {})) as {
      connectors: Array<Record<string, unknown>>;
      catalog: Array<Record<string, unknown>>;
    };

    expect(result.connectors[0]).toMatchObject({
      provider: "notion",
      hasCredential: true,
      capabilities: { sync: true, saveItem: false, publishEvent: false, sendEmail: false },
    });
    expect(result.connectors[0]).not.toHaveProperty("accessToken");
    expect(result.catalog.length).toBeGreaterThan(0);
  });
});

describe("executeTool — sync_connector", () => {
  it("runs the sync lane against the group id and records success", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    const result = (await toolset.executeTool(CONNECTOR_TOOL_SYNC, { provider: "notion" })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(lanes.sync).toHaveBeenCalledWith(GROUP_ID, "notion");
    expect(dbState.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncError: null }),
    );
  });

  it("rejects a provider that does not support sync", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_SYNC, { provider: "gmail" }),
    ).rejects.toThrow(/not supported/i);
    expect(lanes.sync).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider id", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_SYNC, { provider: "not-a-provider" }),
    ).rejects.toThrow(/unknown connector provider/i);
  });

  it("records the error message when the lane throws", async () => {
    lanes.sync.mockRejectedValueOnce(new Error("notion token expired"));
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_SYNC, { provider: "notion" }),
    ).rejects.toThrow(/notion token expired/);
    expect(dbState.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncError: "notion token expired" }),
    );
  });
});

describe("executeTool — save_email_to_resources", () => {
  it("defaults the provider to gmail and requires an itemId", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await toolset.executeTool(CONNECTOR_TOOL_SAVE_EMAIL, { itemId: "gmail-msg-7" });
    expect(lanes.save).toHaveBeenCalledWith(GROUP_ID, "gmail", "gmail-msg-7");
  });

  it("rejects when itemId is missing", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_SAVE_EMAIL, {}),
    ).rejects.toThrow(/required/i);
    expect(lanes.save).not.toHaveBeenCalled();
  });
});

describe("executeTool — send_email", () => {
  it("sends through the gmail lane with recipient/subject/body", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await toolset.executeTool(CONNECTOR_TOOL_SEND_EMAIL, {
      to: "alice@example.com",
      subject: "Hello",
      body: "Hi there",
    });
    expect(lanes.send).toHaveBeenCalledWith(
      GROUP_ID,
      "gmail",
      expect.objectContaining({ to: "alice@example.com", subject: "Hello", body: "Hi there" }),
    );
  });

  it("rejects when the recipient is missing", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_SEND_EMAIL, { subject: "S", body: "x" }),
    ).rejects.toThrow(/recipient/i);
    expect(lanes.send).not.toHaveBeenCalled();
  });
});

describe("executeTool — publish_event", () => {
  it("publishes through the luma lane with the resource id", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await toolset.executeTool(CONNECTOR_TOOL_PUBLISH_EVENT, { resourceId: "res-9" });
    expect(lanes.publish).toHaveBeenCalledWith(GROUP_ID, "luma", "res-9");
  });

  it("rejects when the resource id is missing", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool(CONNECTOR_TOOL_PUBLISH_EVENT, {}),
    ).rejects.toThrow(/required/i);
    expect(lanes.publish).not.toHaveBeenCalled();
  });
});

describe("executeTool — unknown tool", () => {
  it("throws on an unrecognized tool name", async () => {
    const toolset = buildGroupConnectorTools({ groupId: GROUP_ID, canAct: true })!;
    await expect(
      toolset.executeTool("definitely_not_a_tool", {}),
    ).rejects.toThrow(/unknown connector tool/i);
  });
});
