import { beforeEach, describe, expect, it, vi } from "vitest";

const connectorRows = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const runConnectorSyncMock = vi.hoisted(() => vi.fn());
const updateSet = vi.hoisted(() => vi.fn(() => ({ where: vi.fn(async () => undefined) })));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => connectorRows.rows) })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

vi.mock("@/lib/connectors/notion-sync", () => ({
  runConnectorSync: runConnectorSyncMock,
  SYNCABLE_CONNECTOR_PROVIDERS: ["notion"] as const,
}));

import { GET, POST } from "@/app/api/cron/connector-sync/route";

const CRON_SECRET = "test-connector-secret";

function authedRequest(): Request {
  return new Request("https://group.rivr.social/api/cron/connector-sync", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

describe("POST /api/cron/connector-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectorRows.rows = [];
    process.env.CONNECTOR_SYNC_CRON_SECRET = CRON_SECRET;
  });

  it("rejects requests without the cron secret", async () => {
    const response = await POST(
      new Request("https://group.rivr.social/api/cron/connector-sync", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(runConnectorSyncMock).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong cron secret", async () => {
    const response = await POST(
      new Request("https://group.rivr.social/api/cron/connector-sync", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses to run when the cron secret is unset", async () => {
    delete process.env.CONNECTOR_SYNC_CRON_SECRET;
    const response = await POST(authedRequest());
    expect(response.status).toBe(401);
    expect(runConnectorSyncMock).not.toHaveBeenCalled();
  });

  it("runs sync for each syncable connector and reports processed outcomes", async () => {
    connectorRows.rows = [
      { userAgentId: "agent-1", provider: "notion" },
      { userAgentId: "agent-2", provider: "notion" },
    ];
    runConnectorSyncMock.mockResolvedValue({ imported: 2, updated: 1, skipped: 0 });

    const response = await POST(authedRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
    expect(runConnectorSyncMock).toHaveBeenCalledTimes(2);
    expect(runConnectorSyncMock).toHaveBeenCalledWith("agent-1", "notion");
    expect(body.results.every((r: { outcome: string }) => r.outcome === "processed")).toBe(true);
    expect(body.results[0].result).toMatchObject({ imported: 2, updated: 1 });
  });

  it("records provider errors per connector without aborting the run", async () => {
    connectorRows.rows = [
      { userAgentId: "agent-1", provider: "notion" },
      { userAgentId: "agent-2", provider: "notion" },
    ];
    runConnectorSyncMock
      .mockRejectedValueOnce(new Error("token expired"))
      .mockResolvedValueOnce({ imported: 0, updated: 0, skipped: 3 });

    const response = await POST(authedRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.processed).toBe(2);
    expect(body.results[0]).toMatchObject({ outcome: "provider_error", message: "token expired" });
    expect(body.results[1]).toMatchObject({ outcome: "processed" });
  });

  it("returns an empty summary when no syncable connectors exist", async () => {
    connectorRows.rows = [];
    const response = await POST(authedRequest());
    const body = await response.json();
    expect(body.processed).toBe(0);
    expect(body.results).toEqual([]);
    expect(runConnectorSyncMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/connector-sync", () => {
  it("rejects GET with 405", () => {
    const response = GET();
    expect(response.status).toBe(405);
  });
});
