import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Stripe + connect-account substrate so the payout logic is tested in
// isolation (no real Stripe calls).
const mocks = vi.hoisted(() => ({
  ensureConnectAccountForAgent: vi.fn(),
  getConnectPayoutReadiness: vi.fn(),
  getPlatformAvailableCents: vi.fn(),
  createTransfer: vi.fn(),
}));

vi.mock("@/lib/connect-account", () => ({
  ensureConnectAccountForAgent: mocks.ensureConnectAccountForAgent,
}));
vi.mock("@/lib/stripe-connect", () => ({
  getConnectPayoutReadiness: mocks.getConnectPayoutReadiness,
  getPlatformAvailableCents: mocks.getPlatformAvailableCents,
  createTransfer: mocks.createTransfer,
}));

import { settleConnectPayout, isConnectPayoutsEnabled } from "@/lib/connect-payout";

const BASE = {
  payeeAgentId: "agent-1",
  amountCents: 5000,
  idempotencyKey: "receipt-1",
  metadata: { jobId: "job-1" },
};

describe("settleConnectPayout", () => {
  const prev = process.env.STRIPE_CONNECT_PAYOUTS_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = "true";
    mocks.ensureConnectAccountForAgent.mockResolvedValue({ connectAccountId: "acct_x", created: false });
    mocks.getConnectPayoutReadiness.mockResolvedValue({ chargesEnabled: true, payoutsEnabled: true, transfersActive: true });
    mocks.getPlatformAvailableCents.mockResolvedValue(1_000_000);
    mocks.createTransfer.mockResolvedValue({ id: "tr_123" });
  });
  afterEach(() => {
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = prev;
  });

  it("is disabled when the flag is off", async () => {
    process.env.STRIPE_CONNECT_PAYOUTS_ENABLED = "false";
    expect(isConnectPayoutsEnabled()).toBe(false);
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("disabled");
    expect(mocks.createTransfer).not.toHaveBeenCalled();
  });

  it("pays via a real transfer when ready and funded", async () => {
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("paid");
    expect(r.transferId).toBe("tr_123");
    expect(r.connectAccountId).toBe("acct_x");
    expect(mocks.createTransfer).toHaveBeenCalledWith("acct_x", 5000, {
      idempotencyKey: "connect-payout:receipt-1",
      metadata: { payeeAgentId: "agent-1", jobId: "job-1" },
    });
  });

  it("returns needs_onboarding when transfers capability is inactive", async () => {
    mocks.getConnectPayoutReadiness.mockResolvedValue({ chargesEnabled: false, payoutsEnabled: false, transfersActive: false });
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("needs_onboarding");
    expect(r.connectAccountId).toBe("acct_x");
    expect(mocks.createTransfer).not.toHaveBeenCalled();
  });

  it("returns insufficient_funds when the platform balance is short", async () => {
    mocks.getPlatformAvailableCents.mockResolvedValue(100);
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("insufficient_funds");
    expect(mocks.createTransfer).not.toHaveBeenCalled();
  });

  it("captures Stripe errors as status=error, never throws", async () => {
    mocks.createTransfer.mockRejectedValue(new Error("stripe boom"));
    const r = await settleConnectPayout(BASE);
    expect(r.status).toBe("error");
    expect(r.detail).toContain("stripe boom");
  });

  it("rejects a non-positive amount", async () => {
    const r = await settleConnectPayout({ ...BASE, amountCents: 0 });
    expect(r.status).toBe("error");
  });
});
