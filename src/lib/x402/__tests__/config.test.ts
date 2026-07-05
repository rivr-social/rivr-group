import { afterEach, describe, expect, it } from "vitest";

/**
 * Unit coverage for x402 protocol/network configuration.
 *
 * Invariants under test: friendly network names canonicalize to CAIP-2 while
 * CAIP-2/unknown values pass through; cents→atomic-unit conversion is exact
 * (BigInt) and rejects non-integers; env resolvers fall back safely on
 * missing/garbage values.
 */

import {
  X402_DEFAULT_PROTOCOL_VERSION,
  X402_FALLBACK_ASSET,
  X402_FALLBACK_ASSET_DECIMALS,
  X402_FALLBACK_NETWORK,
  centsToAtomicUnits,
  isCaip2Network,
  resolveDefaultAsset,
  resolveDefaultAssetDecimals,
  resolveDefaultNetwork,
  resolveProtocolVersion,
  toCaip2Network,
} from "../config";

const ENV_KEYS = [
  "X402_PROTOCOL_VERSION",
  "X402_DEFAULT_NETWORK",
  "X402_DEFAULT_ASSET",
  "X402_DEFAULT_ASSET_DECIMALS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("toCaip2Network / isCaip2Network", () => {
  it("maps friendly names to CAIP-2 chain ids", () => {
    expect(toCaip2Network("base")).toBe("eip155:8453");
    expect(toCaip2Network("Base-Sepolia")).toBe("eip155:84532");
    expect(toCaip2Network("  polygon  ")).toBe("eip155:137");
  });

  it("passes CAIP-2 ids and unknown networks through verbatim", () => {
    expect(toCaip2Network("eip155:84532")).toBe("eip155:84532");
    expect(toCaip2Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    );
    expect(toCaip2Network("somefuturechain")).toBe("somefuturechain");
    expect(toCaip2Network("")).toBe("");
  });

  it("isCaip2Network recognizes the namespace:reference grammar", () => {
    expect(isCaip2Network("eip155:8453")).toBe(true);
    expect(isCaip2Network("base")).toBe(false);
    expect(isCaip2Network("")).toBe(false);
  });
});

describe("centsToAtomicUnits", () => {
  it("converts cents to atomic units for 6-decimal assets (USDC)", () => {
    expect(centsToAtomicUnits(250, 6)).toBe("2500000");
    expect(centsToAtomicUnits(1, 6)).toBe("10000");
    expect(centsToAtomicUnits(0, 6)).toBe("0");
  });

  it("handles large amounts without float error", () => {
    expect(centsToAtomicUnits(123_456_789_00, 18)).toBe("123456789000000000000000000");
  });

  it("floors sub-cent precision assets", () => {
    expect(centsToAtomicUnits(250, 0)).toBe("2");
    expect(centsToAtomicUnits(250, 1)).toBe("25");
  });

  it("rejects non-integer inputs", () => {
    expect(() => centsToAtomicUnits(2.5, 6)).toThrow(RangeError);
    expect(() => centsToAtomicUnits(-1, 6)).toThrow(RangeError);
    expect(() => centsToAtomicUnits(100, -1)).toThrow(RangeError);
    expect(() => centsToAtomicUnits(100, undefined as unknown as number)).toThrow(RangeError);
  });
});

describe("env resolvers — safe fallbacks", () => {
  it("resolveProtocolVersion falls back on unset/garbage and honors valid values", () => {
    expect(resolveProtocolVersion()).toBe(X402_DEFAULT_PROTOCOL_VERSION);
    process.env.X402_PROTOCOL_VERSION = "garbage";
    expect(resolveProtocolVersion()).toBe(X402_DEFAULT_PROTOCOL_VERSION);
    process.env.X402_PROTOCOL_VERSION = "0";
    expect(resolveProtocolVersion()).toBe(X402_DEFAULT_PROTOCOL_VERSION);
    process.env.X402_PROTOCOL_VERSION = "2";
    expect(resolveProtocolVersion()).toBe(2);
  });

  it("resolveDefaultNetwork/Asset honor env and fall back when unset", () => {
    expect(resolveDefaultNetwork()).toBe(X402_FALLBACK_NETWORK);
    expect(resolveDefaultAsset()).toBe(X402_FALLBACK_ASSET);
    process.env.X402_DEFAULT_NETWORK = "base-sepolia";
    process.env.X402_DEFAULT_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(resolveDefaultNetwork()).toBe("base-sepolia");
    expect(resolveDefaultAsset()).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("resolveDefaultAssetDecimals validates range and falls back on garbage", () => {
    expect(resolveDefaultAssetDecimals()).toBe(X402_FALLBACK_ASSET_DECIMALS);
    process.env.X402_DEFAULT_ASSET_DECIMALS = "18";
    expect(resolveDefaultAssetDecimals()).toBe(18);
    process.env.X402_DEFAULT_ASSET_DECIMALS = "-3";
    expect(resolveDefaultAssetDecimals()).toBe(X402_FALLBACK_ASSET_DECIMALS);
    process.env.X402_DEFAULT_ASSET_DECIMALS = "not-a-number";
    expect(resolveDefaultAssetDecimals()).toBe(X402_FALLBACK_ASSET_DECIMALS);
  });
});
