// src/lib/federation/instance-config.ts

/**
 * Instance identity configuration.
 * Each Rivr deployment (container) has its own identity defined by env vars.
 * The global/platform instance uses defaults when env vars are not set.
 */

export type InstanceType = 'global' | 'person' | 'group' | 'locale' | 'region';

export interface InstanceConfig {
  /** UUID identifying this instance */
  instanceId: string;
  /** What kind of instance this is */
  instanceType: InstanceType;
  /** Human-readable slug (e.g., 'portland-food-coop') */
  instanceSlug: string;
  /** UUID of the primary agent this instance serves (group ID, person ID, etc.) */
  primaryAgentId: string | null;
  /** URL of the global registry API for resolving other instances */
  registryUrl: string;
  /** MinIO bucket prefix for this instance's storage */
  minioBucketPrefix: string;
  /** Base URL of this instance (for federation peering) */
  baseUrl: string;
  /** Whether this is the global/platform instance */
  isGlobal: boolean;
  /** Crypto wallet address for fee collection (if global instance) */
  feeWalletAddress?: string;
}

// Default global instance ID — well-known UUID
const GLOBAL_INSTANCE_ID = '00000000-0000-0000-0000-000000000001';

let _cachedConfig: InstanceConfig | null = null;

export function getInstanceConfig(): InstanceConfig {
  if (_cachedConfig) return _cachedConfig;

  const instanceId = process.env.INSTANCE_ID || GLOBAL_INSTANCE_ID;
  const instanceType = (process.env.INSTANCE_TYPE || 'global') as InstanceType;
  const instanceSlug = process.env.INSTANCE_SLUG || 'global';
  const primaryAgentId = process.env.PRIMARY_AGENT_ID || null;
  const registryUrl = process.env.REGISTRY_URL || ''; // empty = this IS the registry
  const minioBucketPrefix = process.env.MINIO_BUCKET_PREFIX || '';
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
  const feeWalletAddress = process.env.FEE_WALLET_ADDRESS || undefined;

  _cachedConfig = {
    instanceId,
    instanceType,
    instanceSlug,
    primaryAgentId,
    registryUrl,
    minioBucketPrefix,
    baseUrl,
    isGlobal: instanceType === 'global',
    feeWalletAddress,
  };

  return _cachedConfig;
}

/** Check if the current instance is the global/platform instance */
export function isGlobalInstance(): boolean {
  return getInstanceConfig().isGlobal;
}

/**
 * Check if the current instance is a peer (i.e., not the global).
 *
 * A "peer" is any instance whose `INSTANCE_TYPE` env is not `global`
 * (person, group, locale, region, or any future narrower scope).
 * Used by the central mailer to decide whether to delegate transactional
 * email to the global identity authority instead of sending locally.
 *
 * @returns `true` when INSTANCE_TYPE !== 'global'.
 */
export function isPeerInstance(): boolean {
  return !getInstanceConfig().isGlobal;
}

/**
 * Returns the configured global identity authority base URL that peer
 * instances should delegate email relay to, or `null` when unset.
 *
 * Reads `GLOBAL_IDENTITY_AUTHORITY_URL` from `process.env`. Intentionally
 * not cached so operators can update the env without restarting tests.
 *
 * @returns Base URL (no trailing slash guarantee) or `null`.
 */
export function getGlobalIdentityAuthorityUrl(): string | null {
  const raw = process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Should the current instance delegate outbound transactional email
 * to the global identity authority (instead of sending locally via SMTP)?
 *
 * True when this instance is a peer (not global) AND a global identity
 * authority URL is configured. When a peer has no URL configured, the
 * mailer will fall back to local SMTP and emit a boot-time warning via
 * {@link warnIfPeerMissingGlobalEmailAuthority}.
 *
 * @returns `true` iff the instance is a peer and GLOBAL_IDENTITY_AUTHORITY_URL is set.
 */
export function shouldDelegateEmail(): boolean {
  return isPeerInstance() && getGlobalIdentityAuthorityUrl() !== null;
}

let _peerEmailWarningEmitted = false;

/**
 * Emit a one-shot boot-time warning when the current instance is a peer
 * but `GLOBAL_IDENTITY_AUTHORITY_URL` is not configured. Peers without a
 * configured authority will attempt local SMTP as a fallback; in
 * practice most peer containers ship without working SMTP so this is
 * almost always an operator misconfiguration.
 *
 * Idempotent: the warning is logged at most once per process.
 *
 * @returns Nothing.
 */
export function warnIfPeerMissingGlobalEmailAuthority(): void {
  if (_peerEmailWarningEmitted) return;
  if (!isPeerInstance()) return;
  if (getGlobalIdentityAuthorityUrl() !== null) return;
  _peerEmailWarningEmitted = true;
  console.warn(
    "[mailer] Peer instance email will not deliver — " +
      "set GLOBAL_IDENTITY_AUTHORITY_URL to the global authority base URL " +
      "(e.g. https://a.rivr.social) so transactional email can be relayed.",
  );
}

/** Get the well-known global instance UUID */
export function getGlobalInstanceId(): string {
  return GLOBAL_INSTANCE_ID;
}

/** Reset cached config (for testing) */
export function resetInstanceConfig(): void {
  _cachedConfig = null;
  _peerEmailWarningEmitted = false;
}
