// src/lib/federation/global-url.ts

/**
 * Client-safe utility to derive the global instance base URL
 * from the REGISTRY_URL environment variable.
 *
 * REGISTRY_URL format: https://b.rivr.social/api/federation/registry
 * Global base URL:     https://b.rivr.social
 *
 * Falls back to NEXT_PUBLIC_GLOBAL_URL or NEXT_PUBLIC_BASE_URL if set,
 * then to the current window origin.
 */

/** Path suffix that the registry API is served on */
const REGISTRY_PATH_SUFFIX = "/api/federation/registry";

/**
 * Canonical default when no env hints are available. Matches the workspace
 * CLAUDE.md / ticket #109 expectation that GLOBAL === `https://app.rivr.social`
 * (the production global).
 */
const DEFAULT_GLOBAL_BASE_URL = "https://app.rivr.social";

/**
 * Derive the global (platform) instance base URL.
 *
 * Resolution order:
 * 1. NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL or GLOBAL_IDENTITY_AUTHORITY_URL
 *    (explicit federation-wide override)
 * 2. NEXT_PUBLIC_GLOBAL_URL (legacy override still honored)
 * 3. REGISTRY_URL with the API path stripped
 * 4. NEXT_PUBLIC_BASE_URL (assumes this IS the global instance)
 * 5. DEFAULT_GLOBAL_BASE_URL — `https://app.rivr.social`
 */
export function getGlobalBaseUrl(): string {
  // Ticket #109: prefer the canonical identity-authority env used across
  // rivr-monorepo / rivr-person / rivr-group / rivr-locale-commons /
  // rivr-bioregional.
  const identityAuthority =
    process.env.NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL ||
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
  if (identityAuthority) {
    return identityAuthority.replace(/\/+$/, "");
  }

  // Legacy explicit global URL override
  const explicitGlobal = process.env.NEXT_PUBLIC_GLOBAL_URL;
  if (explicitGlobal) {
    return explicitGlobal.replace(/\/+$/, "");
  }

  // Derive from registry URL by stripping the API path
  const registryUrl = process.env.NEXT_PUBLIC_REGISTRY_URL || process.env.REGISTRY_URL;
  if (registryUrl) {
    const idx = registryUrl.indexOf(REGISTRY_PATH_SUFFIX);
    if (idx !== -1) {
      return registryUrl.substring(0, idx);
    }
    // Registry URL doesn't end with the expected path — try to extract origin
    try {
      const url = new URL(registryUrl);
      return url.origin;
    } catch {
      // Malformed URL — fall through
    }
  }

  // If this is the global instance itself, BASE_URL works
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (baseUrl) {
    return baseUrl.replace(/\/+$/, "");
  }

  return DEFAULT_GLOBAL_BASE_URL;
}

/**
 * Build a URL on the global instance for a given path.
 *
 * @param path - Path relative to the global instance root (e.g., "/map").
 * @returns Full URL string on the global instance.
 */
export function getGlobalUrl(path: string): string {
  const base = getGlobalBaseUrl();
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}
