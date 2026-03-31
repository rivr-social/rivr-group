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

/** Get the well-known global instance UUID */
export function getGlobalInstanceId(): string {
  return GLOBAL_INSTANCE_ID;
}

/** Reset cached config (for testing) */
export function resetInstanceConfig(): void {
  _cachedConfig = null;
}
