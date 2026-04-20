/**
 * Peer outgoing SMTP configuration loader (ticket #106).
 *
 * Purpose:
 * - Looks up the `peer_smtp_config` row for the current instance.
 * - Resolves the SMTP password from the configured secret reference
 *   (env var name OR Docker secret mount path) at send time — the
 *   table NEVER stores plaintext credentials.
 * - Caches the resolved config in-memory for a short TTL so the hot
 *   path (every outbound transactional email on a peer) doesn't hit
 *   the DB + filesystem on every send.
 *
 * Security contract:
 * - `password_secret_ref` is interpreted as:
 *     * an absolute filesystem path (starts with `/`) — read once
 *       from disk (Docker / k8s secret mount).
 *     * otherwise, a `process.env` variable name.
 * - A resolved empty string is treated as "not configured" and the
 *   helper returns `null` so the mailer falls through to the global
 *   relay rather than attempting an auth-less SMTP handshake.
 *
 * Key exports:
 * - {@link PeerSmtpConfig}
 * - {@link getPeerSmtpConfig}
 * - {@link resetPeerSmtpConfigCache}
 *
 * Dependencies:
 * - `@/db` + `peerSmtpConfig` schema
 * - `./instance-config` for the running instance's UUID
 */

import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { peerSmtpConfig, type PeerSmtpConfigRecord } from "@/db/schema";
import { getInstanceConfig } from "./instance-config";

/** Cache TTL for the resolved config (30s). Short enough that toggling */
/** the enabled flag in the admin UI takes effect almost immediately. */
export const PEER_SMTP_CACHE_TTL_MS = 30_000;

/**
 * Resolved peer SMTP configuration, with the password already
 * dereferenced from the secret source. Safe to hand directly to a
 * nodemailer transport. Never serialize this — it carries the
 * plaintext password in-process only.
 */
export interface PeerSmtpConfig {
  /** Row id (for updates by the admin API). */
  id: string;
  /** Instance UUID this config is tied to. */
  instanceId: string;
  /** Whether the peer opts into outgoing SMTP. */
  enabled: boolean;
  /** SMTP host (e.g. `smtp.gmail.com`). */
  host: string;
  /** SMTP port (typically 587 for STARTTLS, 465 for implicit TLS). */
  port: number;
  /** True for implicit TLS (port 465); false for STARTTLS. */
  secure: boolean;
  /** Auth username — usually the from address. */
  username: string;
  /** From address used for the SMTP envelope + Header `From`. */
  fromAddress: string;
  /** Resolved plaintext password (never persisted). */
  password: string;
  /** The raw reference string (env name or secret path) — for UI display. */
  passwordSecretRef: string;
  /** Timestamp of last admin-initiated test send, if any. */
  lastTestAt: Date | null;
  /** Status of last test send: `ok` | `failed` | null. */
  lastTestStatus: string | null;
  /** Error text from the last failed test, if any. */
  lastTestError: string | null;
}

interface CacheEntry {
  value: PeerSmtpConfig | null;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;

/**
 * Clear the in-memory cache. Call after admin upsert/delete operations
 * so the next send picks up the new config immediately. Also used by
 * tests between cases.
 *
 * @returns Nothing.
 */
export function resetPeerSmtpConfigCache(): void {
  _cache = null;
}

/**
 * Read a secret reference and return the plaintext value.
 *
 * - Absolute paths (`/run/secrets/...`) are read from disk.
 * - Anything else is treated as a `process.env` variable name.
 * - Returns an empty string if the reference resolves to nothing;
 *   callers treat that as "not configured".
 *
 * @param ref Reference string stored in `peer_smtp_config.password_secret_ref`.
 * @returns Resolved plaintext secret, or empty string on miss.
 */
export function resolvePeerSmtpSecret(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) {
    try {
      return readFileSync(trimmed, "utf8").trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[peer-smtp] Could not read secret file ${trimmed}: ${message}`,
      );
      return "";
    }
  }
  return (process.env[trimmed] ?? "").trim();
}

/**
 * Fetch + resolve the current instance's peer SMTP config.
 *
 * Returns `null` when:
 * - No row exists for the instance.
 * - The row exists but `enabled = false`.
 * - The password secret reference resolves to an empty string.
 *
 * The cache is keyed on the running instance's id and expires after
 * {@link PEER_SMTP_CACHE_TTL_MS}. Admin writes MUST call
 * {@link resetPeerSmtpConfigCache} to invalidate.
 *
 * @returns Resolved config, or `null` if the peer should fall back
 *   to the global relay.
 */
export async function getPeerSmtpConfig(): Promise<PeerSmtpConfig | null> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return _cache.value;
  }

  const { instanceId } = getInstanceConfig();

  const rows = await db
    .select()
    .from(peerSmtpConfig)
    .where(eq(peerSmtpConfig.instanceId, instanceId))
    .limit(1);

  const row: PeerSmtpConfigRecord | undefined = rows[0];
  if (!row || !row.enabled) {
    _cache = { value: null, expiresAt: now + PEER_SMTP_CACHE_TTL_MS };
    return null;
  }

  const password = resolvePeerSmtpSecret(row.passwordSecretRef);
  if (!password) {
    console.warn(
      `[peer-smtp] Config enabled for instance ${instanceId} but password secret ${row.passwordSecretRef} resolved empty; falling back to relay`,
    );
    _cache = { value: null, expiresAt: now + PEER_SMTP_CACHE_TTL_MS };
    return null;
  }

  const resolved: PeerSmtpConfig = {
    id: row.id,
    instanceId: row.instanceId,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.fromAddress,
    password,
    passwordSecretRef: row.passwordSecretRef,
    lastTestAt: row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    lastTestError: row.lastTestError,
  };

  _cache = { value: resolved, expiresAt: now + PEER_SMTP_CACHE_TTL_MS };
  return resolved;
}
