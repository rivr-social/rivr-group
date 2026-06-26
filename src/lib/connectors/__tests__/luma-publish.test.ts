import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRow = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
const updateCapture = vi.hoisted(() => ({ metadata: null as unknown }));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (selectRow.row ? [selectRow.row] : [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        if ("metadata" in patch) updateCapture.metadata = patch.metadata;
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  },
}));

vi.mock("@/lib/crypto/secret-box", () => ({
  decryptSecret: vi.fn((value: string | null | undefined) => value ?? null),
}));

import {
  buildLumaEventPayload,
  publishEventToLuma,
  runConnectorEventPublish,
} from "@/lib/connectors/luma-publish";
import { getSourceBlock } from "@/lib/resources/source-block";

const OWNER = "agent-owner";

function eventRow(extra: Record<string, unknown> = {}) {
  return {
    accessToken: "luma-key",
    id: "res-1",
    name: "Community Potluck",
    description: "Bring a dish",
    type: "event",
    ownerId: OWNER,
    metadata: {
      date: "2026-07-01",
      time: "18:00",
      timezone: "America/Denver",
      location: "The Commons",
      ...((extra.metadata as Record<string, unknown>) ?? {}),
    },
    ...extra,
  };
}

describe("buildLumaEventPayload", () => {
  it("maps name/start/timezone and appends a RIVR backlink", () => {
    const payload = buildLumaEventPayload({
      id: "res-1",
      name: "Community Potluck",
      description: "Bring a dish",
      metadata: { date: "2026-07-01", time: "18:00", timezone: "America/Denver" },
    });
    expect(payload.name).toBe("Community Potluck");
    expect(payload.timezone).toBe("America/Denver");
    expect(payload.start_at).toContain("2026-07-01");
    expect(payload.description_md).toContain("Bring a dish");
    expect(payload.description_md).toContain("View on RIVR:");
    expect(payload.description_md).toContain("/events/res-1");
  });

  it("defaults timezone to UTC when the event omits one", () => {
    const payload = buildLumaEventPayload({
      id: "res-2",
      name: "No TZ",
      description: null,
      metadata: { date: "2026-07-01", time: "09:00" },
    });
    expect(payload.timezone).toBe("UTC");
  });

  it("passes a URL location through as meeting_url", () => {
    const payload = buildLumaEventPayload({
      id: "res-3",
      name: "Online Sync",
      description: null,
      metadata: { date: "2026-07-01", time: "09:00", location: "https://meet.example.com/x" },
    });
    expect(payload.meeting_url).toBe("https://meet.example.com/x");
  });

  it("omits meeting_url for a physical location", () => {
    const payload = buildLumaEventPayload({
      id: "res-4",
      name: "In Person",
      description: null,
      metadata: { date: "2026-07-01", time: "09:00", location: "The Commons" },
    });
    expect(payload.meeting_url).toBeUndefined();
  });
});

describe("publishEventToLuma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRow.row = eventRow();
    updateCapture.metadata = null;
  });

  it("creates a Luma event on first publish and stamps the source block", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/events/create")) {
        return new Response(JSON.stringify({ id: "evt-123" }), { status: 200 });
      }
      if (url.includes("/events/get")) {
        return new Response(JSON.stringify({ id: "evt-123", url: "https://lu.ma/abc" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishEventToLuma(OWNER, "res-1");

    expect(result).toMatchObject({
      provider: "luma",
      outcome: "created",
      externalId: "evt-123",
      externalUrl: "https://lu.ma/abc",
    });
    const stamped = getSourceBlock(updateCapture.metadata as Record<string, unknown>);
    expect(stamped).toMatchObject({
      provider: "luma",
      externalId: "evt-123",
      provenance: "rivr_outbound",
      syncMode: "one-way",
      lane: "typed",
    });
  });

  it("updates the linked Luma event on re-publish instead of creating a duplicate", async () => {
    selectRow.row = eventRow({
      metadata: {
        date: "2026-07-01",
        time: "18:00",
        timezone: "America/Denver",
        source: {
          provider: "luma",
          externalId: "evt-existing",
          lane: "typed",
          syncMode: "one-way",
          provenance: "rivr_outbound",
          externalUrl: "https://lu.ma/old",
          externalUpdatedAt: "2026-06-01T00:00:00.000Z",
          externalEtag: null,
          contentHash: null,
          mirroredAt: "2026-06-01T00:00:00.000Z",
          syncedAt: "2026-06-01T00:00:00.000Z",
          providerMeta: {},
        },
      },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/events/update")) return new Response("{}", { status: 200 });
      if (url.includes("/events/get")) {
        return new Response(JSON.stringify({ id: "evt-existing", url: "https://lu.ma/new" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishEventToLuma(OWNER, "res-1");

    expect(result).toMatchObject({ outcome: "updated", externalId: "evt-existing" });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/events/create"))).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/events/update"))).toBe(true);
  });

  it("rejects publishing an event the agent does not own", async () => {
    selectRow.row = eventRow({ ownerId: "someone-else" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(publishEventToLuma(OWNER, "res-1")).rejects.toThrow(/owner/i);
  });

  it("rejects publishing a non-event resource", async () => {
    selectRow.row = eventRow({ type: "document" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(publishEventToLuma(OWNER, "res-1")).rejects.toThrow(/event resources/i);
  });

  it("surfaces an honest error when no connector is configured", async () => {
    selectRow.row = eventRow({ accessToken: null });
    vi.stubGlobal("fetch", vi.fn());
    await expect(publishEventToLuma(OWNER, "res-1")).rejects.toThrow(/No Luma connector/i);
  });
});

describe("runConnectorEventPublish", () => {
  it("rejects providers that do not support event publish", async () => {
    await expect(runConnectorEventPublish(OWNER, "notion", "res-1")).rejects.toThrow(/not supported/i);
  });
});
