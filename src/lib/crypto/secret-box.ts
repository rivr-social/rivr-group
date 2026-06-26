/**
 * @fileoverview Authenticated encryption-at-rest for stored third-party secrets.
 *
 * Connector secrets (OAuth access/refresh tokens, pasted API keys for messenger
 * bridges, Notion, Gmail, and other providers) must never be persisted as
 * plaintext. The group repo stores connector credentials in the
 * `user_connectors` table's `access_token` / `refresh_token` text columns, which
 * previously held those values in the clear. This module wraps AES-256-GCM so
 * those columns hold ciphertext instead, while remaining backward compatible
 * with values written before encryption existed.
 *
 * Storage format (kept inside the existing text columns — no schema change):
 *
 *   enc:v1:<base64url(iv)>:<base64url(authTag)>:<base64url(ciphertext)>
 *
 * `decryptSecret` recognizes that prefix; any value WITHOUT it is treated as
 * legacy plaintext and returned unchanged, so reads keep working during the
 * transition. The next write re-stores the value as ciphertext via
 * `encryptSecret`, so plaintext is phased out lazily without a migration job.
 *
 * Key material:
 * - Primary: `CONNECTOR_ENCRYPTION_KEY` — 32 bytes, supplied as base64 or hex.
 * - Fallback: derived from `AUTH_SECRET` via scrypt so the feature is usable in
 *   development without provisioning a second secret. Production deployments
 *   MUST set `CONNECTOR_ENCRYPTION_KEY` explicitly; rotating `AUTH_SECRET` would
 *   otherwise make existing ciphertext undecryptable.
 *
 * Ported from the person app (`rivr-social/rivr-person`
 * src/lib/crypto/secret-box.ts) so the group connector lane shares the same
 * on-disk envelope and key-derivation rules as the person and global lanes.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

import { getEnv } from "@/lib/env";

/** Algorithm: 256-bit key, GCM authenticated mode. */
const ALGORITHM = "aes-256-gcm";
/** AES-256 key length in bytes. */
const KEY_LENGTH_BYTES = 32;
/** Recommended GCM IV length in bytes (96-bit nonce). */
const IV_LENGTH_BYTES = 12;
/** GCM authentication tag length in bytes. */
const AUTH_TAG_LENGTH_BYTES = 16;
/** Self-describing prefix marking a value as ciphertext written by this module. */
const CIPHERTEXT_PREFIX = "enc:v1:";
/** Fixed salt for the scrypt fallback key derivation from AUTH_SECRET. */
const SCRYPT_FALLBACK_SALT = "rivr.connector.secret-box.v1";

/** Memoized key so we derive/parse it once per process. */
let cachedKey: Buffer | null = null;

/**
 * Resolves the 32-byte symmetric key, preferring an explicit
 * `CONNECTOR_ENCRYPTION_KEY` (base64 or hex) and falling back to a scrypt
 * derivation from `AUTH_SECRET`.
 *
 * @throws {Error} When neither a valid explicit key nor `AUTH_SECRET` is set.
 */
function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = process.env.CONNECTOR_ENCRYPTION_KEY?.trim();
  if (explicit) {
    const decoded = decodeKeyMaterial(explicit);
    if (decoded.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        `CONNECTOR_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${decoded.length}). Provide 32 bytes as base64 or hex.`,
      );
    }
    cachedKey = decoded;
    return cachedKey;
  }

  const authSecret = getEnv("AUTH_SECRET");
  if (!authSecret) {
    throw new Error(
      "Cannot encrypt connector secrets: set CONNECTOR_ENCRYPTION_KEY (32 bytes base64/hex) or AUTH_SECRET.",
    );
  }
  cachedKey = scryptSync(authSecret, SCRYPT_FALLBACK_SALT, KEY_LENGTH_BYTES);
  return cachedKey;
}

/**
 * Decodes user-supplied key material as base64 first, then hex. A 64-char hex
 * string also happens to be valid base64, so hex is attempted only when base64
 * decoding does not yield exactly the key length.
 */
function decodeKeyMaterial(value: string): Buffer {
  const asBase64 = Buffer.from(value, "base64");
  if (asBase64.length === KEY_LENGTH_BYTES) return asBase64;
  const asHex = Buffer.from(value, "hex");
  if (asHex.length === KEY_LENGTH_BYTES) return asHex;
  // Return whichever we got so the length check upstream reports a clear error.
  return asBase64;
}

/**
 * Returns `true` when a stored value is ciphertext produced by this module.
 * Used to distinguish encrypted fields from legacy plaintext.
 */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX);
}

/**
 * Encrypts a plaintext secret into the self-describing ciphertext envelope.
 *
 * @param plaintext - The secret to protect (e.g. an OAuth token or API key).
 * @returns The `enc:v1:…` envelope string, or `null` when given null/empty.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  // Already encrypted — never double-wrap.
  if (isEncryptedSecret(plaintext)) return plaintext;
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CIPHERTEXT_PREFIX.slice(0, -1), // "enc:v1"
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypts a value previously produced by {@link encryptSecret}. Values that are
 * not in the ciphertext envelope (legacy plaintext) are returned unchanged so
 * reads keep working until the row is rewritten.
 *
 * @throws {Error} When the envelope is malformed or authentication fails (which
 *                 indicates tampering or a wrong/rotated key).
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!isEncryptedSecret(stored)) return stored; // legacy plaintext

  const parts = stored.split(":");
  // ["enc","v1",iv,tag,ct]
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted secret envelope: expected enc:v1:iv:tag:ciphertext.");
  }
  const [, , ivB64, tagB64, ctB64] = parts;
  const key = resolveKey();
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
