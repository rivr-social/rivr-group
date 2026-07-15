import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Global-URL resolution is mocked so the client's target is deterministic.
vi.mock("@/lib/federation/global-url", () => ({
  getGlobalUrl: (path: string) => `https://global.test${path}`,
}));

import { settleConnectPayout, isConnectPayoutsEnabled } from "@/lib/connect-payout";

const BASE = {
  payeeAgentId: "agent-1",
  amountCents: 5000,
  idempotencyKey: "receipt-1",
  metadata: { jobId: "job-1" },
};

/** Installs a fetch stub returning `body` with `ok`/`status`. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("settleConnectPayout (sovereign → global client)", () => {
  const prevFlag = process.env.STRIPE_CONNECT_PAYOUTS_ENABLED;
  const prevSlug = process.env.INSTANCE_SLUG;
  const prevSecret = process.env.FEDERATION_PEER_SECRET_GLOBAL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = "true";
    process.env.INSTANCE_SLUG = "mutual-aid-boulder";
    process.env.FEDERATION_PEER_SECRET_GLOBAL = "s3cr3t";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = prevFlag;
    process.env.INSTANCE_SLUG = prevSlug;
    process.env.FEDERATION_PEER_SECRET_GLOBAL = prevSecret;
  });

  it("is disabled when the flag is off", async () => {
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = "false";
    const fetchFn = stubFetch({});
    expect(isConnectPayoutsEnabled()).toBe(false);
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("disabled");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts a peer-authed request to global's payout endpoint and returns its verdict", async () => {
    const fetchFn = stubFetch({ status: "paid", transferId: "tr_123", connectAccountId: "acct_x" });
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("paid");
    expect(r.transferId).toBe("tr_123");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://global.test/api/federation/connect/payout");
    expect(init.method).toBe("POST");
    expect(init.headers["x-peer-slug"]).toBe("mutual-aid-boulder");
    expect(init.headers["x-peer-secret"]).toBe("s3cr3t");
    expect(JSON.parse(init.body)).toMatchObject({
      payeeAgentId: "agent-1",
      amountCents: 5000,
      idempotencyKey: "receipt-1",
    });
  });

  it("falls back to x-node-admin-key when no peer secret is set", async () => {
    delete process.env.FEDERATION_PEER_SECRET_GLOBAL;
    process.env.NODE_ADMIN_KEY = "admin-key";
    const fetchFn = stubFetch({ status: "paid", transferId: "tr_9" });
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("paid");
    expect(fetchFn.mock.calls[0][1].headers["x-node-admin-key"]).toBe("admin-key");
    delete process.env.NODE_ADMIN_KEY;
  });

  it("returns error (no transfer) when no peer credential is configured", async () => {
    delete process.env.FEDERATION_PEER_SECRET_GLOBAL;
    delete process.env.NODE_ADMIN_KEY;
    const fetchFn = stubFetch({});
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("error");
    expect(r.detail).toContain("peer credential");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a non-ok global response to error with its message", async () => {
    stubFetch({ error: "Peer is not trusted" }, false, 401);
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("error");
    expect(r.detail).toContain("Peer is not trusted");
  });

  it("rejects a non-positive amount before any call", async () => {
    const fetchFn = stubFetch({});
    const r = await settleConnectPayout({ ...BASE, amountCents: 0 });
    expect(r.status).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
