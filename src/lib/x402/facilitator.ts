/**
 * x402 facilitator client.
 *
 * Purpose:
 * - Talk to an x402 facilitator (Coinbase-hosted or self-hosted) to verify a
 *   client-supplied payment payload against PaymentRequirements (non-mutating)
 *   and to settle it onchain (mutating).
 * - The facilitator is the only party that touches the chain; RIVR never holds
 *   keys here. RIVR's job is to gate, then persist its own receipt.
 *
 * Configuration (env):
 * - `X402_FACILITATOR_URL` — base URL of the facilitator. When unset, the
 *   facilitator is treated as not configured and callers must surface 503.
 *     - dev  : `https://x402.org/facilitator` (free, no key, Base Sepolia).
 *     - prod : the Coinbase CDP facilitator URL (free-tier mainnet USDC).
 * - `X402_FACILITATOR_API_KEY` — optional bearer token for hosted facilitators
 *   (required by the Coinbase CDP facilitator; unset for the free x402.org one).
 * - Protocol/network/asset defaults live in `./config`
 *   (`X402_PROTOCOL_VERSION`, `X402_DEFAULT_NETWORK`, `X402_DEFAULT_ASSET`,
 *   `X402_DEFAULT_ASSET_DECIMALS`) so the same code runs dev (Base Sepolia) and
 *   prod (Base mainnet) with NO code fork.
 *
 * Wire compatibility (x402Version 2):
 * - `/verify` and `/settle` take `{ x402Version, paymentPayload, paymentRequirements }`.
 * - `network` is CAIP-2 (`eip155:8453` / `eip155:84532`); requirements carry it
 *   already (see `buildPaymentRequirements`).
 * - VerifyResult `{ isValid, invalidReason?, payer? }` and SettleResult
 *   `{ success, transaction, network, payer?, errorReason? }` match the v2 shapes.
 *
 * Dependencies:
 * - `fetch` (Node 22 / Next runtime). No npm SDK dependency is introduced.
 * - `./config` for the protocol-version fallback when a client omits x402Version.
 */

import type { PaymentRequirements } from "./policy";
import { resolveProtocolVersion } from "./config";

/** Verify endpoint path on the facilitator. */
const FACILITATOR_VERIFY_PATH = "/verify";
/** Settle endpoint path on the facilitator. */
const FACILITATOR_SETTLE_PATH = "/settle";
/** Supported-kinds discovery path on the facilitator (GET). */
const FACILITATOR_SUPPORTED_PATH = "/supported";
/** Network timeout for facilitator calls (ms). */
const FACILITATOR_TIMEOUT_MS = 15_000;

/**
 * Decoded x402 payment payload as carried (base64) in the `X-PAYMENT` header.
 * The exact `payload` shape is scheme/network-specific and forwarded verbatim
 * to the facilitator; RIVR does not interpret its internals.
 */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

/** Facilitator verify result (non-mutating, no chain write). */
export interface VerifyResult {
  isValid: boolean;
  /** Reason code when invalid (passed through from facilitator). */
  invalidReason?: string;
  /** Payer address the facilitator extracted from the payload, when valid. */
  payer?: string;
}

/** Facilitator settle result (after the onchain transfer). */
export interface SettleResult {
  success: boolean;
  /** Settlement transaction hash, present on success. */
  transaction?: string;
  /** Network the settlement landed on. */
  network?: string;
  /** Payer address, when known. */
  payer?: string;
  /** Error code/string when settlement failed. */
  errorReason?: string;
}

/** Raised when the facilitator is not configured or is unreachable. */
export class X402FacilitatorError extends Error {
  /** True when the cause is missing configuration (callers should 503). */
  readonly notConfigured: boolean;
  constructor(message: string, options?: { notConfigured?: boolean }) {
    super(message);
    this.name = "X402FacilitatorError";
    this.notConfigured = options?.notConfigured ?? false;
  }
}

/**
 * Reads and validates facilitator configuration from the environment.
 *
 * @returns The resolved base URL and optional API key.
 * @throws {X402FacilitatorError} (notConfigured) when `X402_FACILITATOR_URL` is unset.
 */
function getFacilitatorConfig(): { baseUrl: string; apiKey: string | null } {
  const baseUrl = process.env.X402_FACILITATOR_URL?.trim();
  if (!baseUrl) {
    throw new X402FacilitatorError(
      "X402_FACILITATOR_URL is not configured; paid access is unavailable.",
      { notConfigured: true },
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env.X402_FACILITATOR_API_KEY?.trim() || null,
  };
}

/**
 * Issues a JSON POST to a facilitator endpoint with a bounded timeout.
 *
 * @param path Endpoint path (e.g. "/verify").
 * @param body Request body, JSON-serialized.
 * @returns Parsed JSON response.
 * @throws {X402FacilitatorError} On network failure, timeout, or non-2xx status.
 */
async function facilitatorPost<T>(path: string, body: unknown): Promise<T> {
  const { baseUrl, apiKey } = getFacilitatorConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new X402FacilitatorError(
        `Facilitator ${path} returned ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof X402FacilitatorError) throw error;
    throw new X402FacilitatorError(
      `Facilitator ${path} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies a payment payload against requirements. Non-mutating: no chain
 * write happens here, so it is safe to call before deciding to settle.
 *
 * @param payment Decoded payment payload from the `X-PAYMENT` header.
 * @param requirements The PaymentRequirements the server advertised in its 402.
 * @returns The facilitator's verification verdict.
 * @throws {X402FacilitatorError} When the facilitator is unconfigured/unreachable.
 */
export async function verifyPayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  return facilitatorPost<VerifyResult>(FACILITATOR_VERIFY_PATH, {
    x402Version: payment.x402Version || resolveProtocolVersion(),
    paymentPayload: payment,
    paymentRequirements: requirements,
  });
}

/**
 * Settles a verified payment onchain via the facilitator. Mutating: this
 * triggers the asset transfer to `requirements.payTo`.
 *
 * @param payment Decoded payment payload from the `X-PAYMENT` header.
 * @param requirements The PaymentRequirements the server advertised in its 402.
 * @returns The settlement result including the transaction hash on success.
 * @throws {X402FacilitatorError} When the facilitator is unconfigured/unreachable.
 */
export async function settlePayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResult> {
  return facilitatorPost<SettleResult>(FACILITATOR_SETTLE_PATH, {
    x402Version: payment.x402Version || resolveProtocolVersion(),
    paymentPayload: payment,
    paymentRequirements: requirements,
  });
}

/** One entry of the facilitator `/supported` response — a payable kind. */
export interface SupportedPaymentKind {
  x402Version: number;
  scheme: string;
  /** CAIP-2 chain id (e.g. `eip155:84532`). */
  network: string;
  extra?: Record<string, unknown>;
}

/** Facilitator `/supported` response: the schemes/networks it can settle. */
export interface SupportedKindsResult {
  kinds: SupportedPaymentKind[];
}

/**
 * Fetches the facilitator's advertised `/supported` kinds. Used to confirm a
 * configured (network, scheme, x402Version) triple is actually settleable —
 * the recommended pre-flight when wiring a new facilitator or network.
 *
 * @returns The supported kinds the facilitator advertises.
 * @throws {X402FacilitatorError} When the facilitator is unconfigured/unreachable.
 */
export async function fetchSupportedKinds(): Promise<SupportedKindsResult> {
  const { baseUrl, apiKey } = getFacilitatorConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${FACILITATOR_SUPPORTED_PATH}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new X402FacilitatorError(
        `Facilitator ${FACILITATOR_SUPPORTED_PATH} returned ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { kinds?: SupportedPaymentKind[] };
    return { kinds: Array.isArray(body.kinds) ? body.kinds : [] };
  } catch (error) {
    if (error instanceof X402FacilitatorError) throw error;
    throw new X402FacilitatorError(
      `Facilitator ${FACILITATOR_SUPPORTED_PATH} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decodes the base64 `X-PAYMENT` header into a {@link PaymentPayload}.
 *
 * @param header Raw `X-PAYMENT` header value (base64 JSON), or null.
 * @returns The decoded payload, or null when absent/malformed.
 */
export function decodePaymentHeader(header: string | null): PaymentPayload | null {
  if (!header || !header.trim()) return null;
  try {
    const json = Buffer.from(header.trim(), "base64").toString("utf-8");
    const parsed = JSON.parse(json) as PaymentPayload;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.scheme === "string" &&
      typeof parsed.network === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encodes a settlement result into the base64 `X-PAYMENT-RESPONSE` header value
 * the client receives alongside the 200.
 *
 * @param settle The successful settlement result.
 * @returns Base64-encoded JSON for the `X-PAYMENT-RESPONSE` header.
 */
export function encodePaymentResponseHeader(settle: SettleResult): string {
  return Buffer.from(
    JSON.stringify({
      success: settle.success,
      transaction: settle.transaction,
      network: settle.network,
      payer: settle.payer,
    }),
    "utf-8",
  ).toString("base64");
}
