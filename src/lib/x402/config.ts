/**
 * x402 protocol + network configuration.
 *
 * Purpose:
 * - Single source of truth for the x402 protocol VERSION the ecosystem speaks,
 *   the default settlement NETWORK / ASSET when a per-resource policy omits one,
 *   and the CAIP-2 canonicalization the current (v2) facilitator requires.
 * - Lets an operator point the SAME code at a different facilitator + network
 *   purely through env — with NO code fork:
 *     - dev  -> the free x402.org facilitator on Base Sepolia
 *              (`X402_DEFAULT_NETWORK=base-sepolia`, testnet USDC, no API key).
 *     - prod -> Coinbase CDP facilitator on Base mainnet
 *              (`X402_DEFAULT_NETWORK=base`, real USDC, CDP key).
 *
 * Why CAIP-2 matters:
 * - The x402 facilitator migrated from x402Version 1 (plain network strings like
 *   "base") to x402Version 2, whose `/supported` advertises kinds keyed by CAIP-2
 *   chain ids (e.g. `eip155:8453` Base mainnet, `eip155:84532` Base Sepolia).
 *   Owners may still store a friendly name ("base"); {@link toCaip2Network} maps
 *   it to the CAIP-2 id on the wire while passing already-CAIP-2 ids through.
 *
 * Env (all optional; safe fallbacks preserve prior mainnet-USDC behaviour):
 * - `X402_PROTOCOL_VERSION`      int   — x402Version sent to the facilitator and
 *                                        advertised in the 402 body. Default 2.
 * - `X402_DEFAULT_NETWORK`       str   — network when a policy omits one. Accepts
 *                                        a friendly name ("base", "base-sepolia")
 *                                        OR a CAIP-2 id ("eip155:84532"). Default "base".
 * - `X402_DEFAULT_ASSET`         str   — asset when a policy omits one. A symbol
 *                                        ("USDC") for display, or — for real
 *                                        settlement — the ERC-20 contract address
 *                                        on the target network. Default "USDC".
 * - `X402_DEFAULT_ASSET_DECIMALS` int  — decimals of the default asset, used to
 *                                        render `maxAmountRequired` in atomic
 *                                        units. USDC = 6. Default 6.
 *
 * Dependencies:
 * - Reads `process.env` at call time (functions, not import-time snapshots) so a
 *   runtime env change is honoured and unit tests can toggle behaviour. No DB, no
 *   network, no other RIVR module — safe to import anywhere.
 */

/** x402 protocol version the ecosystem speaks when env is unset (current: 2). */
export const X402_DEFAULT_PROTOCOL_VERSION = 2;
/** Fallback settlement network (Base mainnet, friendly form) when env is unset. */
export const X402_FALLBACK_NETWORK = "base";
/** Fallback settlement asset (USDC symbol) when env is unset. */
export const X402_FALLBACK_ASSET = "USDC";
/** Fallback decimals for the default asset (USDC has 6) when env is unset. */
export const X402_FALLBACK_ASSET_DECIMALS = 6;

/**
 * Friendly network name -> CAIP-2 chain id, for the well-known EVM chains x402
 * settles on. Keys are lower-cased at lookup. Unlisted / already-CAIP-2 values
 * pass through {@link toCaip2Network} verbatim.
 */
const CAIP2_BY_FRIENDLY_NAME: Record<string, string> = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  ethereum: "eip155:1",
  "ethereum-mainnet": "eip155:1",
  mainnet: "eip155:1",
  "ethereum-sepolia": "eip155:11155111",
  sepolia: "eip155:11155111",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  "arbitrum": "eip155:42161",
  "optimism": "eip155:10",
};

/** CAIP-2 chain-id shape: `<namespace>:<reference>` (e.g. `eip155:8453`). */
const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/**
 * True when `network` is already a CAIP-2 chain id (namespace:reference).
 *
 * @param network A network identifier (friendly name or CAIP-2 id).
 * @returns Whether the value matches the CAIP-2 grammar.
 */
export function isCaip2Network(network: string): boolean {
  return CAIP2_PATTERN.test(network.trim());
}

/**
 * Canonicalizes a network identifier to the CAIP-2 form the v2 facilitator
 * expects. Friendly names ("base", "base-sepolia") map to their chain id;
 * values that are already CAIP-2 — or an unknown id we cannot map — pass
 * through verbatim so a new chain works without a code change.
 *
 * @param network A friendly name or CAIP-2 id (may be untrimmed).
 * @returns The CAIP-2 id when known, else the trimmed input unchanged.
 */
export function toCaip2Network(network: string): string {
  const trimmed = network.trim();
  if (!trimmed) return trimmed;
  const mapped = CAIP2_BY_FRIENDLY_NAME[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}

/**
 * Resolves the x402 protocol version from `X402_PROTOCOL_VERSION`, falling back
 * to {@link X402_DEFAULT_PROTOCOL_VERSION}. Non-numeric / non-positive values
 * fall back rather than propagate a bad version to the facilitator.
 *
 * @returns A positive integer x402 protocol version.
 */
export function resolveProtocolVersion(): number {
  const raw = process.env.X402_PROTOCOL_VERSION?.trim();
  if (!raw) return X402_DEFAULT_PROTOCOL_VERSION;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : X402_DEFAULT_PROTOCOL_VERSION;
}

/**
 * Resolves the default settlement network from `X402_DEFAULT_NETWORK`, falling
 * back to {@link X402_FALLBACK_NETWORK}. The returned value may be a friendly
 * name or a CAIP-2 id; callers that hit the facilitator should pass it through
 * {@link toCaip2Network}.
 *
 * @returns The configured default network identifier.
 */
export function resolveDefaultNetwork(): string {
  return process.env.X402_DEFAULT_NETWORK?.trim() || X402_FALLBACK_NETWORK;
}

/**
 * Resolves the default settlement asset from `X402_DEFAULT_ASSET`, falling back
 * to {@link X402_FALLBACK_ASSET}. May be a display symbol ("USDC") or, for real
 * settlement, the ERC-20 contract address on the target network.
 *
 * @returns The configured default asset symbol/address.
 */
export function resolveDefaultAsset(): string {
  return process.env.X402_DEFAULT_ASSET?.trim() || X402_FALLBACK_ASSET;
}

/**
 * Resolves the default asset's decimal precision from
 * `X402_DEFAULT_ASSET_DECIMALS`, falling back to
 * {@link X402_FALLBACK_ASSET_DECIMALS} (6, for USDC). Out-of-range values fall
 * back rather than corrupt the atomic-unit amount.
 *
 * @returns Asset decimals in the inclusive range [0, 36].
 */
export function resolveDefaultAssetDecimals(): number {
  const raw = process.env.X402_DEFAULT_ASSET_DECIMALS?.trim();
  if (!raw) return X402_FALLBACK_ASSET_DECIMALS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36
    ? parsed
    : X402_FALLBACK_ASSET_DECIMALS;
}

/**
 * Converts an integer US-cents price to the asset's atomic (smallest) units as
 * a decimal string — the form x402 `maxAmountRequired` requires.
 *
 * atomic = majorUnits * 10^decimals, and majorUnits = priceCents / 100, so
 * atomic = priceCents * 10^(decimals - 2). For USDC (6 decimals): 250 cents
 * ($2.50) -> "2500000". BigInt math avoids float error on large amounts.
 *
 * @param priceCents Non-negative integer price in US cents.
 * @param decimals Non-negative integer asset decimals (USDC = 6).
 * @returns The amount in atomic units as a base-10 string.
 * @throws {RangeError} When `priceCents` or `decimals` is not a non-negative integer.
 */
export function centsToAtomicUnits(priceCents: number, decimals: number): string {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError(
      `centsToAtomicUnits: priceCents must be a non-negative integer, got ${priceCents}`,
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `centsToAtomicUnits: decimals must be a non-negative integer, got ${decimals}`,
    );
  }
  const cents = BigInt(priceCents);
  if (decimals >= 2) {
    return (cents * 10n ** BigInt(decimals - 2)).toString();
  }
  // Sub-cent asset precision (decimals 0 or 1): floor to the smallest unit.
  const divisor = 10n ** BigInt(2 - decimals);
  return (cents / divisor).toString();
}
