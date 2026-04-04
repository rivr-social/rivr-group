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
 * Derive the global (platform) instance base URL.
 *
 * Resolution order:
 * 1. NEXT_PUBLIC_GLOBAL_URL (explicit override)
 * 2. REGISTRY_URL with the API path stripped
 * 3. NEXT_PUBLIC_BASE_URL (assumes this IS the global instance)
 * 4. Window origin (client-side fallback)
 * 5. Empty string (SSR fallback)
 */
export function getGlobalBaseUrl(): string {
  // Explicit global URL override
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

  // Client-side fallback
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "";
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
