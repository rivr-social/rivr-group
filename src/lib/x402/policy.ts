/**
 * Per-resource x402 payment policy model.
 *
 * Purpose:
 * - Resolve whether a single resource exposes an x402 (HTTP 402 Payment
 *   Required) paid-access path, and on what terms.
 * - x402 is OFF by default for every resource. A resource only becomes
 *   payable when its owner explicitly opts in by persisting an
 *   `x402` policy object under `resources.metadata` (set from the
 *   filesystem/documents view).
 *
 * Trust frame (verified-principal rail):
 * - x402 is the third access path in the audit model: a request is served
 *   when the caller is (a) a verified principal with (b) an explicit grant,
 *   OR (c) presents a settled payment for a record that opted into x402.
 *   This module only answers "did this record opt in, and on what terms" —
 *   it never decides identity or grant.
 *
 * Dependencies:
 * - `./config` for env-driven default network/asset/decimals and CAIP-2
 *   canonicalization. Aside from those (call-time) env reads via config, this
 *   module holds no DB/network I/O and is safe to unit-test in isolation.
 */

import {
  centsToAtomicUnits,
  resolveDefaultAsset,
  resolveDefaultAssetDecimals,
  resolveDefaultNetwork,
  toCaip2Network,
} from "./config";

/**
 * Default settlement asset when a policy omits one — boot-time snapshot of
 * {@link resolveDefaultAsset} (env `X402_DEFAULT_ASSET`, fallback "USDC").
 */
export const X402_DEFAULT_ASSET = resolveDefaultAsset();
/**
 * Default settlement network when a policy omits one — boot-time snapshot of
 * {@link resolveDefaultNetwork} (env `X402_DEFAULT_NETWORK`, fallback "base").
 */
export const X402_DEFAULT_NETWORK = resolveDefaultNetwork();
/** Floor price for a payable record; rejects zero/negative opt-ins. */
export const X402_MIN_PRICE_CENTS = 1;

/**
 * Stored per-resource x402 policy as it lives under
 * `resources.metadata.x402`. Every field is optional on the wire because the
 * record may have been written by an older client; {@link resolveResourceX402Policy}
 * normalizes and validates it.
 */
export interface StoredX402Policy {
  /** Master opt-in switch. Absent or non-true means x402 is OFF. */
  enabled?: boolean;
  /** Price in integer US cents. Must be >= {@link X402_MIN_PRICE_CENTS}. */
  priceCents?: number;
  /** Settlement asset symbol (e.g. "USDC") or ERC-20 contract address. */
  asset?: string;
  /** Decimals of the settlement asset (USDC = 6); used for atomic-unit amounts. */
  assetDecimals?: number;
  /** Settlement network — friendly ("base", "base-sepolia") or CAIP-2 ("eip155:84532"). */
  network?: string;
  /** Onchain address that receives settlement. Required when enabled. */
  payTo?: string;
  /** Optional human-readable description shown in the 402 challenge. */
  description?: string;
  /**
   * Optional scheme-specific extra passed verbatim to the facilitator (e.g. the
   * EIP-712 `{ name, version }` of the ERC-20 for the "exact" EVM scheme).
   */
  extra?: Record<string, unknown>;
}

/**
 * A fully-resolved, validated x402 policy. The presence of this object
 * (vs. `null`) is the single source of truth that a record is payable.
 */
export interface ResolvedX402Policy {
  priceCents: number;
  asset: string;
  /** Decimals of {@link asset}; drives the atomic-unit `maxAmountRequired`. */
  assetDecimals: number;
  network: string;
  payTo: string;
  description?: string;
  /** Scheme-specific extra forwarded verbatim to the facilitator, when present. */
  extra?: Record<string, unknown>;
}

/**
 * Resolves the effective x402 policy for a resource from its metadata.
 *
 * Returns `null` (x402 OFF) for every case that is not an explicit,
 * well-formed opt-in:
 * - metadata is absent / not an object
 * - no `x402` block, or `x402.enabled !== true`
 * - missing or non-positive `priceCents`
 * - missing/blank `payTo` settlement address
 *
 * @param metadata Raw `resources.metadata` (or null).
 * @returns A validated {@link ResolvedX402Policy} when the record opted in, else `null`.
 */
export function resolveResourceX402Policy(
  metadata: Record<string, unknown> | null | undefined,
): ResolvedX402Policy | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const raw = (metadata as { x402?: unknown }).x402;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const policy = raw as StoredX402Policy;

  // Default OFF: only an explicit boolean `true` enables payment.
  if (policy.enabled !== true) {
    return null;
  }

  const priceCents =
    typeof policy.priceCents === "number" && Number.isInteger(policy.priceCents)
      ? policy.priceCents
      : 0;
  if (priceCents < X402_MIN_PRICE_CENTS) {
    return null;
  }

  const payTo = typeof policy.payTo === "string" ? policy.payTo.trim() : "";
  if (!payTo) {
    return null;
  }

  const asset =
    typeof policy.asset === "string" && policy.asset.trim()
      ? policy.asset.trim()
      : resolveDefaultAsset();
  const assetDecimals =
    typeof policy.assetDecimals === "number" &&
    Number.isInteger(policy.assetDecimals) &&
    policy.assetDecimals >= 0
      ? policy.assetDecimals
      : resolveDefaultAssetDecimals();
  const network =
    typeof policy.network === "string" && policy.network.trim()
      ? policy.network.trim()
      : resolveDefaultNetwork();
  const description =
    typeof policy.description === "string" && policy.description.trim()
      ? policy.description.trim()
      : undefined;
  const extra =
    policy.extra &&
    typeof policy.extra === "object" &&
    !Array.isArray(policy.extra)
      ? policy.extra
      : undefined;

  return { priceCents, asset, assetDecimals, network, payTo, description, extra };
}

/**
 * Convenience predicate: is x402 paid access enabled for this metadata?
 *
 * @param metadata Raw `resources.metadata` (or null).
 * @returns True when {@link resolveResourceX402Policy} yields a policy.
 */
export function isResourceX402Enabled(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return resolveResourceX402Policy(metadata) !== null;
}

/**
 * x402 PaymentRequirements as returned in the body of an HTTP 402 challenge.
 * Shape follows the x402 spec so generic clients/facilitators interoperate.
 */
export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2 chain id the v2 facilitator settles on (e.g. `eip155:84532`). */
  network: string;
  /**
   * Largest amount the server will accept, in the asset's ATOMIC (smallest)
   * units as a base-10 string — e.g. USDC (6 decimals) $2.50 -> "2500000".
   */
  maxAmountRequired: string;
  /** Canonical URL of the gated resource the payment unlocks. */
  resource: string;
  /** Human-readable description of what is being purchased. */
  description: string;
  /** MIME type the resource will be served as once paid. */
  mimeType: string;
  /** Settlement recipient address. */
  payTo: string;
  /** Asset symbol or ERC-20 contract address being transferred. */
  asset: string;
  /** Seconds the client has to complete payment before requirements expire. */
  maxTimeoutSeconds: number;
  /** Scheme-specific extra (e.g. EIP-712 `{ name, version }`), when the policy set one. */
  extra?: Record<string, unknown>;
}

/** Default validity window for a 402 challenge (5 minutes). */
export const X402_CHALLENGE_TIMEOUT_SECONDS = 300;

/**
 * Builds spec-shaped PaymentRequirements for a 402 challenge from a resolved
 * policy. Two facilitator-compat transforms happen here:
 * - `network` is canonicalized to CAIP-2 ({@link toCaip2Network}) since the v2
 *   facilitator keys its `/supported` kinds by chain id (`eip155:8453`, ...).
 * - `maxAmountRequired` is rendered in the asset's ATOMIC units
 *   ({@link centsToAtomicUnits}) — the x402 spec requires atomic units, e.g.
 *   250 cents of USDC (6 decimals) -> "2500000", not "2.50".
 *
 * @param policy The resolved, payable policy.
 * @param resourceUrl Canonical URL of the gated resource.
 * @param mimeType MIME type the resource is served as once paid.
 * @returns PaymentRequirements suitable for the 402 response body and facilitator.
 */
export function buildPaymentRequirements(
  policy: ResolvedX402Policy,
  resourceUrl: string,
  mimeType = "application/json",
): PaymentRequirements {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: toCaip2Network(policy.network),
    maxAmountRequired: centsToAtomicUnits(policy.priceCents, policy.assetDecimals),
    resource: resourceUrl,
    description: policy.description ?? "Paid access to a RIVR resource",
    mimeType,
    payTo: policy.payTo,
    asset: policy.asset,
    maxTimeoutSeconds: X402_CHALLENGE_TIMEOUT_SECONDS,
  };
  if (policy.extra) {
    requirements.extra = policy.extra;
  }
  return requirements;
}
