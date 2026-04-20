/**
 * Link preview / URL unfurl utilities.
 *
 * Purpose:
 * - Extract URLs from user-generated post content.
 * - Guard against SSRF by rejecting private, loopback, link-local, and
 *   multicast IP ranges before any outbound fetch occurs.
 * - Short-circuit internal RIVR subspace URLs to avoid outbound fetches for
 *   content this instance already authoritatively owns.
 * - Hash URLs for cache lookup in the `link_previews` table.
 *
 * These helpers are consumed by:
 * - `POST /api/link-preview` (server-side fetch + cache upsert).
 * - `src/components/create-post.tsx` (client-side URL extraction on input).
 * - `src/components/link-preview-card.tsx` (shared Embed shape).
 *
 * Dependencies:
 * - Node `node:crypto` for sha-256 hashing.
 * - Node `node:dns/promises` for DNS resolution in the SSRF guard.
 * - Drizzle schema types via `@/db/schema` for persistence shapes.
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { ResourceEmbed } from '@/db/schema';

/** Default TTL for cached external previews (24 hours). */
export const LINK_PREVIEW_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Clamp: no caller may request a TTL shorter than 60 seconds or longer than 7 days. */
export const LINK_PREVIEW_MIN_TTL_SECONDS = 60;
export const LINK_PREVIEW_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Outbound fetch timeout for OpenGraph scraping. */
export const LINK_PREVIEW_FETCH_TIMEOUT_MS = 8000;

/** Maximum response body we'll accept for OpenGraph scraping (1 MB). */
export const LINK_PREVIEW_MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Status values stored in `link_previews.fetch_status`.
 * - `ok`: successful fetch with at least one usable OG field.
 * - `error`: fetch failed (network, non-2xx, parse error, oversize body, etc.).
 * - `unsupported`: URL was rejected before fetch (non-http(s), SSRF, etc.).
 */
export const FETCH_STATUS = {
  OK: 'ok',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
} as const;
export type FetchStatus = typeof FETCH_STATUS[keyof typeof FETCH_STATUS];

/** Accepted URL protocols. All other schemes are rejected up-front. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * URL extraction regex — matches `http://` or `https://` followed by a run of
 * non-whitespace characters. Tuned for social-post content, not RFC-strict.
 * Trailing punctuation (.,;:!?)] etc.) is trimmed by the caller.
 */
const URL_EXTRACTION_REGEX = /https?:\/\/[^\s<>]+/gi;

/** Punctuation commonly found at the end of a URL in prose that should be trimmed. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * Internal subspace URL path patterns. If a URL's pathname starts with one of
 * these prefixes, we treat it as an internal RIVR link rather than an external
 * OG fetch target.
 */
export const INTERNAL_SUBSPACE_PREFIXES = [
  '/rings/',
  '/groups/',
  '/locales/',
  '/basins/',
  '/families/',
  '/people/',
  '/profile/',
  '/posts/',
  '/events/',
  '/marketplace/',
  '/projects/',
  '/rooms/',
  '/messages/',
] as const;

/**
 * Extract every http(s) URL from a block of text, de-duplicated while
 * preserving first-seen order. Trailing punctuation commonly seen in prose
 * ("See https://example.com.") is stripped.
 *
 * @param text Free-form user input (post body, comment, message).
 * @returns Ordered, de-duplicated list of raw URL strings.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(URL_EXTRACTION_REGEX);
  if (!matches) return out;
  for (const raw of matches) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION, '');
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * Normalize a URL for caching. Lowercases host, strips fragment, and sorts
 * query parameters so that
 *   https://Example.com/a?b=2&a=1#frag
 * and
 *   https://example.com/a?a=1&b=2
 * produce the same hash.
 *
 * @param rawUrl User-provided URL string.
 * @returns Normalized canonical URL, or `null` if `rawUrl` is not parseable.
 */
export function normalizeUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    // Stable query order for deterministic hashing.
    u.searchParams.sort();
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Compute the sha-256 hash of a URL (normalized first) for use as the primary
 * key in `link_previews`.
 *
 * @param rawUrl User-provided URL.
 * @returns Hex-encoded sha-256, or `null` if the URL is unparseable.
 */
export function hashUrl(rawUrl: string): string | null {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Reasons a URL may be rejected before any fetch is attempted.
 */
export const URL_REJECTION_REASON = {
  UNPARSEABLE: 'unparseable',
  BAD_PROTOCOL: 'bad_protocol',
  MISSING_HOSTNAME: 'missing_hostname',
  PRIVATE_HOST: 'private_host',
  BLOCKED_HOST: 'blocked_host',
} as const;
export type UrlRejectionReason =
  typeof URL_REJECTION_REASON[keyof typeof URL_REJECTION_REASON];

export type UrlValidationResult =
  | { ok: true; url: URL; normalized: string }
  | { ok: false; reason: UrlRejectionReason; detail?: string };

/**
 * Hostnames that are always blocked even if DNS would resolve them to a
 * public IP (defense in depth for localhost-style aliases).
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

/**
 * Perform the pre-fetch validation checks that don't require DNS:
 * protocol, parseability, hostname presence, blocked-hostname list.
 *
 * Does NOT perform DNS resolution; call `assertSafeHost` for that.
 *
 * @param rawUrl User-supplied URL string.
 * @returns `{ ok: true, url, normalized }` on success, otherwise a structured
 *   rejection.
 */
export function validateUrlShape(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: URL_REJECTION_REASON.UNPARSEABLE };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: URL_REJECTION_REASON.BAD_PROTOCOL,
      detail: parsed.protocol,
    };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: URL_REJECTION_REASON.MISSING_HOSTNAME };
  }
  if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      reason: URL_REJECTION_REASON.BLOCKED_HOST,
      detail: parsed.hostname,
    };
  }
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return { ok: false, reason: URL_REJECTION_REASON.UNPARSEABLE };
  return { ok: true, url: parsed, normalized };
}

/**
 * Test whether an IPv4 literal falls in a private / loopback / link-local /
 * reserved range that must never be fetched from server-side code.
 *
 * Covers:
 *   - 0.0.0.0/8
 *   - 10.0.0.0/8
 *   - 127.0.0.0/8
 *   - 169.254.0.0/16 (link-local)
 *   - 172.16.0.0/12
 *   - 192.168.0.0/16
 *   - 100.64.0.0/10 (CGNAT — rejected as defense in depth)
 *   - 224.0.0.0/4 (multicast)
 *   - 240.0.0.0/4 (reserved)
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Test whether an IPv6 address falls in a loopback / link-local / unique-local /
 * multicast / unspecified range.
 *
 * Accepts canonical Node-formatted addresses (e.g. `::1`, `fe80::1`).
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1 etc.) — check inner v4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Resolve `hostname` via DNS (A + AAAA) and reject if any resolved address is
 * private, loopback, link-local, multicast, or otherwise non-public.
 *
 * Checks ALL resolved addresses (both families); a host that publishes both a
 * public and a private address is rejected.
 *
 * @param hostname DNS name to resolve.
 * @throws `Error` with message `'private_host'` when any address is unsafe.
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error('private_host');
  }
  for (const rec of records) {
    if (rec.family === 4) {
      if (isPrivateIPv4(rec.address)) throw new Error('private_host');
    } else if (rec.family === 6) {
      if (isPrivateIPv6(rec.address)) throw new Error('private_host');
    }
  }
}

/**
 * Detect whether `rawUrl` points at an internal RIVR subspace on this
 * deployment. Cross-instance links (different host on the federation) are
 * NOT treated as internal here — they should be handled through the
 * federation query layer (see `resolveInternalEmbed` in the route).
 *
 * @param rawUrl URL pasted by user.
 * @param selfHost Host header of the current instance (e.g. "a.rivr.social").
 *   Supply lowercased. When null/undefined, any http(s) URL with a matching
 *   path prefix is treated as internal (useful for dev).
 */
export function isInternalSubspaceUrl(
  rawUrl: string,
  selfHost?: string | null,
): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return false;
  if (selfHost && u.hostname.toLowerCase() !== selfHost.toLowerCase()) {
    return false;
  }
  const path = u.pathname;
  return INTERNAL_SUBSPACE_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/**
 * Classify an internal URL's first path segment so that resolvers can look
 * the entity up in the local DB.
 *
 * @returns Pair of `{ kind, id }` or `null` if unrecognised.
 */
export function parseInternalSubspaceUrl(
  rawUrl: string,
): { kind: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const segs = u.pathname.split('/').filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const [kindSeg, idSeg] = segs;
  const known = new Set([
    'rings',
    'groups',
    'locales',
    'basins',
    'families',
    'people',
    'profile',
    'posts',
    'events',
    'marketplace',
    'projects',
    'rooms',
    'messages',
  ]);
  if (!known.has(kindSeg)) return null;
  return { kind: kindSeg, id: idSeg };
}

/**
 * Shape of the cached row (wire shape — what POST /api/link-preview returns).
 * Stays structurally compatible with `ResourceEmbed` so post composers can
 * attach the response directly to a post's `embeds` field.
 */
export interface LinkPreviewPayload extends ResourceEmbed {
  fetchStatus: FetchStatus;
  fetchedAt: string;
  ttlSeconds: number;
  ogType?: string;
}

/**
 * Whether a cached row is still fresh (now < fetched_at + ttl).
 *
 * @param fetchedAt ISO timestamp / Date from DB.
 * @param ttlSeconds TTL from DB.
 * @param now Injectable clock; defaults to `Date.now()`.
 */
export function isCacheFresh(
  fetchedAt: Date | string,
  ttlSeconds: number,
  now: number = Date.now(),
): boolean {
  const fetched = typeof fetchedAt === 'string' ? new Date(fetchedAt) : fetchedAt;
  const expiresMs = fetched.getTime() + ttlSeconds * 1000;
  return expiresMs > now;
}

/**
 * Clamp a caller-supplied TTL to the allowed range. Returns the default when
 * `candidate` is undefined / NaN / non-positive.
 */
export function clampTtl(candidate: unknown): number {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    return LINK_PREVIEW_DEFAULT_TTL_SECONDS;
  }
  const floored = Math.floor(candidate);
  if (floored < LINK_PREVIEW_MIN_TTL_SECONDS) return LINK_PREVIEW_MIN_TTL_SECONDS;
  if (floored > LINK_PREVIEW_MAX_TTL_SECONDS) return LINK_PREVIEW_MAX_TTL_SECONDS;
  return floored;
}
