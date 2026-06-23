import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/app/actions/group-admin", () => ({ isGroupAdmin: vi.fn(async () => false) }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => selectRows.rows) })) })),
  },
}));

import { GET } from "@/app/api/connectors/route";

describe("GET /api/connectors", () => {
  beforeEach(() => {
    selectRows.rows = [{
      provider: "slack",
      accountEmail: "RIVR",
      tokenExpiresAt: null,
      metadata: {},
      lastSyncedAt: null,
      lastSyncError: null,
      accessToken: "secret-token",
    }];
  });

  it("returns connection status without returning stored credentials", async () => {
    const response = await GET(new Request("https://group.rivr.social/api/connectors"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connections[0]).toMatchObject({ provider: "slack", hasCredential: true });
    expect(body.connections[0]).not.toHaveProperty("accessToken");
  });
});
