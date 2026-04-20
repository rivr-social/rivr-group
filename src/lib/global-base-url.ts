/**
 * Canonical global/federation base URL.
 *
 * The top-left logo link, the locale registry fetch, and any other
 * "point back to GLOBAL" navigation should use this constant so that
 * peer/home/sovereign instances always route discovery queries back
 * to the global identity authority.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL` (client-visible override)
 *   2. `GLOBAL_IDENTITY_AUTHORITY_URL` (server-side env, if forwarded)
 *   3. `https://a.rivr.social` — primary development edge (testA)
 *
 * No trailing slash.
 */

function readEnv(): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return (
      process.env.NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL ||
      process.env.GLOBAL_IDENTITY_AUTHORITY_URL ||
      undefined
    );
  }
  return undefined;
}

export const GLOBAL_BASE_URL: string = (
  readEnv() || "https://a.rivr.social"
).replace(/\/+$/, "");

/**
 * Build an absolute URL into the global instance for the given app path.
 * `path` should start with `/`.
 */
export function globalUrl(path: string = "/"): string {
  const prefix = path.startsWith("/") ? path : `/${path}`;
  return `${GLOBAL_BASE_URL}${prefix}`;
}
