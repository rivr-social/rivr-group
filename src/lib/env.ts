/**
 * Environment configuration loader with defaults, Docker secret-file support,
 * and production-time validation.
 *
 * Key exports:
 * - `getEnv`: resolves one environment variable with fallback rules.
 * - `getAllEnv`: returns a normalized full config snapshot.
 * - `validateEnv`: enforces required production variables at startup.
 *
 * Dependencies:
 * - Node `fs.readFileSync` for reading Docker/Kubernetes secret files.
 * - `process.env` for runtime configuration inputs.
 */
import { readFileSync } from 'fs';

interface EnvConfig {
  NODE_ENV: string;
  DATABASE_URL: string;
  MINIO_ENDPOINT: string;
  MINIO_PORT: string;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_USE_SSL: string;
  MINIO_BUCKET_UPLOADS: string;
  MINIO_BUCKET_AVATARS: string;
  MINIO_BUCKET_EXPORTS: string;
  MINIO_ROOT_USER: string;
  MINIO_ROOT_PASSWORD: string;
  NEXTAUTH_URL: string;
  AUTH_SECRET: string;
  MAPBOX_TOKEN: string;
  NEXT_PUBLIC_MAPBOX_TOKEN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  GOOGLE_MAPS_API_KEY: string;
  GOOGLE_PLACES_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM: string;
  SMTP_SECURE: string;
  SMTP_TLS_REJECT_UNAUTHORIZED: string;
  STRIPE_WEBHOOK_SECRET: string;
  REDIS_URL: string;
  NODE_ADMIN_KEY: string;
  MATRIX_HOMESERVER_URL: string;
  MATRIX_SERVER_NAME: string;
  MATRIX_ADMIN_TOKEN: string;
  NEXT_PUBLIC_MATRIX_HOMESERVER_URL: string;
}

type EnvKey = keyof EnvConfig;

/**
 * Non-sensitive defaults used when explicit env values are not present.
 *
 * Pattern:
 * - Defaults support local development ergonomics.
 * - Sensitive credentials are intentionally excluded.
 */
const ENV_DEFAULTS: Partial<EnvConfig> = {
  NODE_ENV: 'development',
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_BUCKET_UPLOADS: 'rivr-uploads',
  MINIO_BUCKET_AVATARS: 'rivr-avatars',
  MINIO_BUCKET_EXPORTS: 'rivr-exports',
  NEXTAUTH_URL: 'http://localhost:3000',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'noreply@rivr.local',
  SMTP_SECURE: 'false',
  SMTP_TLS_REJECT_UNAUTHORIZED: 'true',
};

/** Production-only required keys that must be explicitly configured. */
const REQUIRED_IN_PRODUCTION: EnvKey[] = [
  'DATABASE_URL',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'AUTH_SECRET',
];

/** Optional keys — features degrade gracefully when these are missing. */
const OPTIONAL_IN_PRODUCTION: EnvKey[] = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
];

/**
 * Reads environment variable with Docker secret fallback
 * @param key - Environment variable name
 * @returns Environment variable value or undefined
 */
function readEnvWithSecret(key: string): string | undefined {
  // First use direct env values so container overrides remain straightforward.
  const envValue = process.env[key];
  if (envValue) {
    return envValue;
  }

  // Fall back to *_FILE convention used by Docker/Kubernetes secret mounts.
  const secretPath = process.env[`${key}_FILE`];
  if (secretPath) {
    try {
      return readFileSync(secretPath, 'utf-8').trim();
    } catch (error) {
      // Warn and continue rather than crashing during optional secret resolution.
      console.warn(`Failed to read secret file for ${key}: ${secretPath}`, error);
    }
  }

  return undefined;
}

/**
 * Gets environment variable value with validation and defaults
 * @param key - Environment variable name
 * @returns Environment variable value
 * @throws Error if a required production variable is missing and has no fallback.
 * @example
 * ```ts
 * const smtpHost = getEnv('SMTP_HOST');
 * ```
 */
export function getEnv(key: EnvKey): string {
  const value = readEnvWithSecret(key);

  if (value !== undefined) {
    return value;
  }

  // Use explicit local defaults for non-sensitive configuration keys.
  const defaultValue = ENV_DEFAULTS[key];
  if (defaultValue !== undefined) {
    return defaultValue;
  }

  // In production, throw error for missing required variables
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && REQUIRED_IN_PRODUCTION.includes(key)) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
      `Set ${key} or ${key}_FILE in production environment.`
    );
  }

  // In non-production, warn and return empty string so local setup can be incremental.
  console.warn(
    `Environment variable ${key} is not set. ` +
    `Using empty string. Set ${key} or ${key}_FILE to configure.`
  );
  return '';
}

/**
 * Gets all environment configuration
 * @returns Complete environment configuration object
 * @throws Error if any required production variable is missing during resolution.
 * @example
 * ```ts
 * const env = getAllEnv();
 * console.log(env.NODE_ENV);
 * ```
 */
export function getAllEnv(): EnvConfig {
  return {
    NODE_ENV: getEnv('NODE_ENV'),
    DATABASE_URL: getEnv('DATABASE_URL'),
    MINIO_ENDPOINT: getEnv('MINIO_ENDPOINT'),
    MINIO_PORT: getEnv('MINIO_PORT'),
    MINIO_ACCESS_KEY: getEnv('MINIO_ACCESS_KEY'),
    MINIO_SECRET_KEY: getEnv('MINIO_SECRET_KEY'),
    MINIO_USE_SSL: getEnv('MINIO_USE_SSL'),
    MINIO_BUCKET_UPLOADS: getEnv('MINIO_BUCKET_UPLOADS'),
    MINIO_BUCKET_AVATARS: getEnv('MINIO_BUCKET_AVATARS'),
    MINIO_BUCKET_EXPORTS: getEnv('MINIO_BUCKET_EXPORTS'),
    MINIO_ROOT_USER: getEnv('MINIO_ROOT_USER'),
    MINIO_ROOT_PASSWORD: getEnv('MINIO_ROOT_PASSWORD'),
    NEXTAUTH_URL: getEnv('NEXTAUTH_URL'),
    AUTH_SECRET: getEnv('AUTH_SECRET'),
    MAPBOX_TOKEN: getEnv('MAPBOX_TOKEN'),
    NEXT_PUBLIC_MAPBOX_TOKEN: getEnv('NEXT_PUBLIC_MAPBOX_TOKEN'),
    STRIPE_SECRET_KEY: getEnv('STRIPE_SECRET_KEY'),
    STRIPE_PUBLISHABLE_KEY: getEnv('STRIPE_PUBLISHABLE_KEY'),
    GOOGLE_MAPS_API_KEY: getEnv('GOOGLE_MAPS_API_KEY'),
    GOOGLE_PLACES_API_KEY: getEnv('GOOGLE_PLACES_API_KEY'),
    ANTHROPIC_API_KEY: getEnv('ANTHROPIC_API_KEY'),
    SMTP_HOST: getEnv('SMTP_HOST'),
    SMTP_PORT: getEnv('SMTP_PORT'),
    SMTP_USER: getEnv('SMTP_USER'),
    SMTP_PASS: getEnv('SMTP_PASS'),
    SMTP_FROM: getEnv('SMTP_FROM'),
    SMTP_SECURE: getEnv('SMTP_SECURE'),
    SMTP_TLS_REJECT_UNAUTHORIZED: getEnv('SMTP_TLS_REJECT_UNAUTHORIZED'),
    STRIPE_WEBHOOK_SECRET: getEnv('STRIPE_WEBHOOK_SECRET'),
    REDIS_URL: getEnv('REDIS_URL'),
    NODE_ADMIN_KEY: getEnv('NODE_ADMIN_KEY'),
    MATRIX_HOMESERVER_URL: getEnv('MATRIX_HOMESERVER_URL'),
    MATRIX_SERVER_NAME: getEnv('MATRIX_SERVER_NAME'),
    MATRIX_ADMIN_TOKEN: getEnv('MATRIX_ADMIN_TOKEN'),
    NEXT_PUBLIC_MATRIX_HOMESERVER_URL: getEnv('NEXT_PUBLIC_MATRIX_HOMESERVER_URL'),
  };
}

/**
 * Validates that all required environment variables are set.
 * Throws on any missing required variable in production.
 *
 * @returns Nothing.
 * @throws Error when one or more production-required variables are missing.
 * @example
 * ```ts
 * validateEnv();
 * ```
 */
export function validateEnv(): void {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const missingRequired: string[] = [];

    for (const key of REQUIRED_IN_PRODUCTION) {
      const value = readEnvWithSecret(key);
      if (!value) {
        // Empty strings are treated as missing for required production secrets.
        missingRequired.push(key);
      }
    }

    if (missingRequired.length > 0) {
      throw new Error(
        `Missing required environment variables in production: ${missingRequired.join(', ')}`
      );
    }

    const missingOptional: string[] = [];
    for (const key of OPTIONAL_IN_PRODUCTION) {
      const value = readEnvWithSecret(key);
      if (!value) {
        missingOptional.push(key);
      }
    }
    if (missingOptional.length > 0) {
      console.warn(
        `[env] Missing optional environment variables: ${missingOptional.join(', ')}. Features depending on these will be unavailable.`
      );
    }
  }
}
