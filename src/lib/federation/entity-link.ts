// src/lib/federation/entity-link.ts

/**
 * Canonical entity link resolution (client-safe, pure).
 *
 * Given an agent/group/person row or federated projection, resolve the correct
 * href for a link to that entity:
 *
 *   - **Locally-homed / renderable** → the local route (e.g. `/profile/<u>`).
 *   - **Remote-homed** (federated projection) → an absolute URL on the entity's
 *     canonical HOME instance. Rendered as a plain anchor by the caller (NO
 *     Next.js `<Link>` prefetch — cross-origin RSC prefetch is the CSP-flash
 *     class).
 *
 * The person app hosts a single person; it has NO `/groups/[id]` route, so a
 * group link can never resolve to a renderable LOCAL page. For groups the
 * caller therefore passes `globalFallback: true` so an entity with no federated
 * home stamp routes to the global aggregator (`app.rivr.social`) — its historic
 * behavior — while a federated projection routes to its true sovereign home
 * (the class of bug this module fixes: e.g. a Spirit membership whose only home
 * stamp is `federatedHomeBaseUrl` was being sent to global and 404ing).
 *
 * Home-base resolution order mirrors `resolveHomeInstance` /
 * `resolveViaHomeBaseUrlMetadata` in `./resolution`, extended with
 * `federatedHomeBaseUrl` — the stamp a federated group projection carries when
 * it has neither `homeBaseUrl` nor `canonicalUrl`:
 *
 *   1. `metadata.homeBaseUrl`
 *   2. `metadata.federatedHomeBaseUrl`
 *   3. origin of `metadata.canonicalUrl`
 *
 * Kept pure (no DB, no async, no framework imports beyond the client-safe
 * `getGlobalUrl`) so it runs in server adapters AND client components, and is
 * unit-testable in isolation.
 */

import { getGlobalUrl } from "./global-url";

/** Strip trailing slashes so base URLs compose/compare consistently. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Ensure a path has exactly one leading slash. */
function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** First non-empty trimmed string among the candidates, else null. */
function firstNonEmptyString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/** Compare two URLs by host only, tolerating parse failures. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * Resolve the remote HOME base URL a federated projection points at.
 *
 * Returns a normalized base URL (no trailing slash) when the entity carries a
 * federated home stamp, or `null` when it does not — i.e. the entity is
 * locally-homed or its origin is unknown.
 */
export function resolveRemoteHomeBaseUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const meta = metadata as Record<string, unknown>;

  const direct = firstNonEmptyString(meta.homeBaseUrl, meta.federatedHomeBaseUrl);
  if (direct) return stripTrailingSlash(direct);

  const canonical = firstNonEmptyString(meta.canonicalUrl);
  if (canonical) {
    try {
      return stripTrailingSlash(new URL(canonical).origin);
    } catch {
      // Malformed canonicalUrl — fall through to null.
    }
  }

  return null;
}

/** Options for {@link resolveEntityHref}. */
export interface ResolveEntityHrefOptions {
  /**
   * Base URL of THIS instance. A federated stamp that points back at our own
   * host is treated as local (loop guard) — mirrors the registry same-host
   * guard in `resolution.ts`. Optional: when omitted, only obviously-remote
   * hosts are treated as remote.
   */
  selfBaseUrl?: string | null;
  /**
   * When the entity has no federated home stamp (locally-homed/unknown), route
   * the local path through the global aggregator instead of returning it
   * verbatim. Pass `true` for entity classes this instance cannot render as a
   * local page (e.g. groups on the person app, which has no `/groups/[id]`
   * route); leave `false` for locally-renderable classes (e.g. person
   * profiles).
   */
  globalFallback?: boolean;
}

/** Result of {@link resolveEntityHref}. */
export interface EntityHrefResult {
  /** The resolved href. Absolute for remote, path (or global URL) for local. */
  href: string;
  /**
   * `true` when the href is an absolute URL on a DIFFERENT origin than this
   * instance — the caller MUST render it as a plain `<a>` (no Next `<Link>`),
   * ideally `target="_blank" rel="noopener noreferrer"`.
   */
  isRemote: boolean;
}

/**
 * Resolve the canonical href for an entity given its LOCAL path.
 *
 * @param metadata  The entity's metadata (federated projection stamps live here).
 * @param localPath The local route for this entity (e.g. `/groups/<id>`).
 * @param options   See {@link ResolveEntityHrefOptions}.
 */
export function resolveEntityHref(
  metadata: unknown,
  localPath: string,
  options: ResolveEntityHrefOptions = {},
): EntityHrefResult {
  const path = ensureLeadingSlash(localPath);
  const remoteBase = resolveRemoteHomeBaseUrl(metadata);

  if (remoteBase) {
    const self = options.selfBaseUrl;
    // A stamp pointing at our own host is local — never emit a cross-origin
    // link back to ourselves.
    if (!self || !sameHost(remoteBase, self)) {
      return { href: `${remoteBase}${path}`, isRemote: true };
    }
  }

  // Locally-homed or unknown origin.
  if (options.globalFallback) {
    return { href: getGlobalUrl(path), isRemote: true };
  }
  return { href: path, isRemote: false };
}
