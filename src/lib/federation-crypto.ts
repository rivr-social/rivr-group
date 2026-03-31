import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Federation cryptography helpers for deterministic payload signing.
 *
 * Purpose:
 * - Canonicalize JSON payloads so signatures are stable across runtimes.
 * - Generate Ed25519 node key pairs.
 * - Sign and verify federation payloads exchanged between nodes.
 *
 * Key exports:
 * - {@link canonicalize}
 * - {@link generateNodeKeyPair}
 * - {@link signPayload}
 * - {@link verifyPayloadSignature}
 *
 * Dependencies:
 * - Node.js `crypto` primitives (`generateKeyPairSync`, `sign`, `verify`).
 */

/**
 * Canonical JSON serialization following RFC 8785 (JSON Canonicalization Scheme).
 * Produces deterministic output by sorting object keys recursively.
 *
 * @param value Arbitrary JSON-compatible input to canonicalize.
 * @returns Canonical JSON string suitable for signing and verification.
 * @throws {TypeError} Propagates serialization errors from `JSON.stringify` for unsupported input values.
 * @example
 * ```ts
 * const canonical = canonicalize({ b: 2, a: 1 });
 * // => '{"a":1,"b":2}'
 * ```
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    // JSON.stringify handles -0 → "0", NaN/Infinity → "null" per spec
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const entries = sortedKeys
      .filter((key) => obj[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Generate an Ed25519 key pair for a federation node.
 * Returns PEM-encoded public and private keys.
 *
 * @param None This function does not accept arguments.
 * @returns Object containing PEM-encoded `publicKey` and `privateKey`.
 * @throws {Error} Throws if key generation fails in the host crypto runtime.
 * @example
 * ```ts
 * const { publicKey, privateKey } = generateNodeKeyPair();
 * ```
 */
export function generateNodeKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/**
 * Sign a federation event payload using Ed25519.
 * Returns a base64-encoded signature string.
 *
 * @param payload JSON-compatible payload to sign.
 * @param privateKeyPem PEM-encoded Ed25519 private key.
 * @returns Base64 signature for the canonicalized payload.
 * @throws {Error} Throws when the key is invalid or signing fails.
 * @example
 * ```ts
 * const signature = signPayload({ id: "evt-1" }, privateKeyPem);
 * ```
 */
export function signPayload(
  payload: Record<string, unknown>,
  privateKeyPem: string
): string {
  // Canonicalization prevents semantically identical objects from producing different signatures.
  const canonical = canonicalize(payload);
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(canonical), key);
  return signature.toString("base64");
}

/**
 * Verify an Ed25519 signature against a federation event payload.
 * Returns true if the signature is valid, false otherwise.
 *
 * @param payload JSON-compatible payload that was originally signed.
 * @param signature Base64-encoded Ed25519 signature.
 * @param publicKeyPem PEM-encoded Ed25519 public key.
 * @returns `true` when verification succeeds; otherwise `false`.
 * @throws {never} This function catches crypto errors and returns `false` instead.
 * @example
 * ```ts
 * const valid = verifyPayloadSignature(payload, signature, publicKeyPem);
 * ```
 */
export function verifyPayloadSignature(
  payload: Record<string, unknown>,
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    // Verification uses the same canonicalization rules as signing to avoid format-based false negatives.
    const canonical = canonicalize(payload);
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(canonical), key, Buffer.from(signature, "base64"));
  } catch {
    // Any parse/key/crypto error is treated as an invalid signature for safer caller behavior.
    return false;
  }
}
