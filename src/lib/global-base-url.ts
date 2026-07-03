/**
 * Canonical global/federation base URL.
 *
 * The top-left logo link, the locale registry fetch, and any other
 * "point back to GLOBAL" navigation should use this constant so that
 * peer/home/sovereign instances always route discovery queries back
 * to the global identity authority.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_GLOBAL_URL` (canonical client-visible env var; preferred)
 *   2. `NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL` (legacy alias)
 *   3. `GLOBAL_IDENTITY_AUTHORITY_URL` (server-side env, if forwarded)
 *   4. `https://app.rivr.social` — production global (canonical fallback)
 *
 * No trailing slash.
 *
 * Note: in addition to this static base, runtime helpers (`isOnGlobalInstance`,
 * `localeHrefForCurrentHost`) detect the actual host the user is browsing
 * from. That matters because in production multiple hostnames
 * (`app.rivr.social`, `a.rivr.social`, `b.rivr.social`, `dev.rivr.social`)
 * are all real "global" runtimes — clicking a locale on any of them must
 * stay on the same host instead of jumping to whatever lane was baked into
 * `NEXT_PUBLIC_GLOBAL_URL` at build time.
 */

function readEnv(): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return (
      process.env.NEXT_PUBLIC_GLOBAL_URL ||
      process.env.NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL ||
      process.env.GLOBAL_IDENTITY_AUTHORITY_URL ||
      undefined
    );
  }
  return undefined;
}

export const GLOBAL_BASE_URL: string = (
  readEnv() || "https://app.rivr.social"
).replace(/\/+$/, "");

/**
 * Hostnames that are themselves global Rivr runtimes. When the user is
 * browsing one of these, "go to global" navigation should stay on the
 * current host instead of cross-origin redirecting to whatever
 * `GLOBAL_BASE_URL` happens to point at.
 *
 * Subdomains of these hosts (e.g. locale instances) are intentionally NOT
 * matched — those are sovereign peers and should still link back to global.
 */
const GLOBAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "app.rivr.social",
  "beta.rivr.social",
  "a.rivr.social",
  "b.rivr.social",
  "dev.rivr.social",
  "localhost",
  "127.0.0.1",
]);

/**
 * Returns true when running in the browser on one of the canonical global
 * hostnames. Returns false on the server (no window) and on peer/sovereign
 * subdomains. Callers should treat the false result as "render absolute
 * cross-origin link to global" and the true result as "stay on current host".
 */
export function isOnGlobalInstance(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return GLOBAL_HOSTNAMES.has(hostname);
}

/**
 * Build a URL for a given path, preferring the current host when the user
 * is already on a global instance and falling back to the configured
 * `GLOBAL_BASE_URL` otherwise.
 *
 * `path` should start with `/`.
 *
 * Use this for navigation that must reach global content — e.g. the locale
 * switcher and the "Browse Rivr" link — without forcing the user off the
 * host they are currently on.
 */
export function localeHrefForCurrentHost(path: string = "/"): string {
  const prefix = path.startsWith("/") ? path : `/${path}`;
  if (isOnGlobalInstance()) {
    // Same-origin relative path keeps the user on the host they are on,
    // including production app.rivr.social.
    return prefix;
  }
  return `${GLOBAL_BASE_URL}${prefix}`;
}

/**
 * Build an absolute URL into the global instance for the given app path.
 * `path` should start with `/`.
 *
 * This always returns an absolute URL anchored at `GLOBAL_BASE_URL`. Prefer
 * `localeHrefForCurrentHost` for in-app navigation that should stay on the
 * current host when the user is already browsing global; reserve
 * `globalUrl` for cases where we explicitly need to point at the canonical
 * configured global authority (federation discovery, server-side fetches,
 * cross-instance manifests, etc.).
 */
export function globalUrl(path: string = "/"): string {
  const prefix = path.startsWith("/") ? path : `/${path}`;
  return `${GLOBAL_BASE_URL}${prefix}`;
}
