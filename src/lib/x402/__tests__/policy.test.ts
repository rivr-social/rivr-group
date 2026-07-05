import { describe, expect, it } from "vitest";

/**
 * Unit coverage for the per-resource x402 policy model.
 *
 * The single invariant under test: x402 is OFF by default. Only an explicit,
 * well-formed opt-in (`enabled: true` + positive integer price + payTo) yields
 * a payable policy; everything else resolves to `null`.
 */

import {
  resolveResourceX402Policy,
  isResourceX402Enabled,
  buildPaymentRequirements,
  X402_DEFAULT_ASSET,
  X402_DEFAULT_NETWORK,
  X402_CHALLENGE_TIMEOUT_SECONDS,
  type ResolvedX402Policy,
} from "../policy";

describe("resolveResourceX402Policy — default OFF", () => {
  it("returns null for absent / empty / non-object metadata", () => {
    expect(resolveResourceX402Policy(null)).toBeNull();
    expect(resolveResourceX402Policy(undefined)).toBeNull();
    expect(resolveResourceX402Policy({})).toBeNull();
    // arrays are not policy objects
    expect(resolveResourceX402Policy([] as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null when there is no x402 block", () => {
    expect(resolveResourceX402Policy({ category: "Governance" })).toBeNull();
  });

  it("returns null when x402 is present but not enabled", () => {
    expect(resolveResourceX402Policy({ x402: {} })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: false, priceCents: 250, payTo: "0xabc" } })).toBeNull();
    // truthy-but-not-true values must not enable
    expect(resolveResourceX402Policy({ x402: { enabled: 1, priceCents: 250, payTo: "0xabc" } })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: "true", priceCents: 250, payTo: "0xabc" } })).toBeNull();
  });

  it("returns null when enabled but missing/invalid price", () => {
    expect(resolveResourceX402Policy({ x402: { enabled: true, payTo: "0xabc" } })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: true, priceCents: 0, payTo: "0xabc" } })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: true, priceCents: -5, payTo: "0xabc" } })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: true, priceCents: 2.5, payTo: "0xabc" } })).toBeNull();
  });

  it("returns null when enabled but missing/blank payTo", () => {
    expect(resolveResourceX402Policy({ x402: { enabled: true, priceCents: 250 } })).toBeNull();
    expect(resolveResourceX402Policy({ x402: { enabled: true, priceCents: 250, payTo: "   " } })).toBeNull();
  });
});

describe("resolveResourceX402Policy — valid opt-in", () => {
  it("resolves a complete policy and trims payTo", () => {
    const policy = resolveResourceX402Policy({
      x402: { enabled: true, priceCents: 250, payTo: "  0xRecipient  ", asset: "USDC", network: "base", description: "Premium doc" },
    });
    expect(policy).toEqual<ResolvedX402Policy>({
      priceCents: 250,
      asset: "USDC",
      assetDecimals: 6,
      network: "base",
      payTo: "0xRecipient",
      description: "Premium doc",
    });
  });

  it("fills asset/network defaults and omits blank description", () => {
    const policy = resolveResourceX402Policy({ x402: { enabled: true, priceCents: 100, payTo: "0xabc" } });
    expect(policy).not.toBeNull();
    expect(policy?.asset).toBe(X402_DEFAULT_ASSET);
    expect(policy?.network).toBe(X402_DEFAULT_NETWORK);
    expect(policy?.description).toBeUndefined();
  });

  it("isResourceX402Enabled mirrors resolution", () => {
    expect(isResourceX402Enabled({ x402: { enabled: true, priceCents: 100, payTo: "0xabc" } })).toBe(true);
    expect(isResourceX402Enabled({ x402: { enabled: false } })).toBe(false);
    expect(isResourceX402Enabled(null)).toBe(false);
  });
});

describe("buildPaymentRequirements", () => {
  it("renders cents in atomic units, canonicalizes network to CAIP-2, and carries policy fields", () => {
    const policy: ResolvedX402Policy = { priceCents: 250, asset: "USDC", assetDecimals: 6, network: "base", payTo: "0xabc" };
    const req = buildPaymentRequirements(policy, "https://app.rivr.social/api/resources/r1/access");
    expect(req.scheme).toBe("exact");
    // 250 cents of a 6-decimals asset = $2.50 = 2_500_000 atomic units.
    expect(req.maxAmountRequired).toBe("2500000");
    // "base" (friendly) canonicalizes to the CAIP-2 chain id the v2 facilitator keys on.
    expect(req.network).toBe("eip155:8453");
    expect(req.asset).toBe("USDC");
    expect(req.payTo).toBe("0xabc");
    expect(req.resource).toBe("https://app.rivr.social/api/resources/r1/access");
    expect(req.maxTimeoutSeconds).toBe(X402_CHALLENGE_TIMEOUT_SECONDS);
    expect(req.mimeType).toBe("application/json");
    expect(req.extra).toBeUndefined();
  });

  it("passes an already-CAIP-2 network through and forwards policy extra", () => {
    const policy: ResolvedX402Policy = {
      priceCents: 100,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      assetDecimals: 6,
      network: "eip155:84532",
      payTo: "0xabc",
      extra: { name: "USDC", version: "2" },
    };
    const req = buildPaymentRequirements(policy, "https://x/r");
    expect(req.network).toBe("eip155:84532");
    expect(req.maxAmountRequired).toBe("1000000");
    expect(req.extra).toEqual({ name: "USDC", version: "2" });
  });

  it("uses the policy description when present", () => {
    const policy: ResolvedX402Policy = { priceCents: 99, asset: "USDC", assetDecimals: 6, network: "base", payTo: "0xabc", description: "Report" };
    expect(buildPaymentRequirements(policy, "https://x/r").description).toBe("Report");
  });
});
