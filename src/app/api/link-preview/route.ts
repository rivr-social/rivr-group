/**
 * Link preview / OpenGraph unfurl API route.
 *
 * Purpose:
 * - Accept a URL pasted by an authenticated user into a post composer (or any
 *   other RIVR surface that supports link unfurling).
 * - Short-circuit internal RIVR subspace URLs by looking the entity up in the
 *   local DB and returning a RIVR-native card, with no outbound fetch.
 * - For external URLs, serve from the `link_previews` cache when fresh;
 *   otherwise fetch OpenGraph metadata via `open-graph-scraper`, persist, and
 *   return the preview.
 *
 * Key exports:
 * - `POST`: main unfurl endpoint. Body: `{ url: string, ttlSeconds?: number }`.
 *
 * Security:
 * - Requires an authenticated session (link preview is not a public anonymous
 *   surface; it triggers outbound fetches on behalf of a user).
 * - Per-user rate limiting to prevent abuse as a proxy / scanner.
 * - SSRF guard: URLs are validated against the allowed-protocol list and
 *   every resolved IP is rejected against private / loopback / link-local /
 *   multicast / reserved ranges before any fetch occurs.
 * - Fetch is hard-capped by timeout and body size.
 *
 * Dependencies:
 * - `open-graph-scraper` for OG metadata extraction.
 * - `@/lib/link-preview` for URL shape/cache helpers and the SSRF guard.
 * - `@/db/schema` for the `linkPreviews` table.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { linkPreviews, agents, resources } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';
import {
  FETCH_STATUS,
  LINK_PREVIEW_FETCH_TIMEOUT_MS,
  LINK_PREVIEW_MAX_BODY_BYTES,
  assertSafeHost,
  clampTtl,
  hashUrl,
  isCacheFresh,
  isInternalSubspaceUrl,
  normalizeUrl,
  parseInternalSubspaceUrl,
  validateUrlShape,
  type FetchStatus,
  type LinkPreviewPayload,
} from '@/lib/link-preview';
import type { ResourceEmbed } from '@/db/schema';

/** Per-user rate limit: at most 60 unfurl requests per minute per user. */
const LINK_PREVIEW_RATE_LIMIT = RATE_LIMITS.SOCIAL;

/** Successful JSON wire shape for POST /api/link-preview. */
interface SuccessResponse {
  ok: true;
  preview: LinkPreviewPayload;
  cached: boolean;
}

/** Error JSON wire shape. */
interface ErrorResponse {
  ok: false;
  error: string;
  detail?: string;
}

/**
 * Serialize a `link_previews` row into the wire shape shared with clients and
 * the resources.embeds column.
 */
function rowToPayload(row: typeof linkPreviews.$inferSelect): LinkPreviewPayload {
  return {
    url: row.url,
    kind: 'link',
    ogTitle: row.ogTitle ?? undefined,
    ogDescription: row.ogDescription ?? undefined,
    ogImage: row.ogImage ?? undefined,
    siteName: row.ogSiteName ?? undefined,
    favicon: row.favicon ?? undefined,
    ogType: row.ogType ?? undefined,
    fetchStatus: (row.fetchStatus as FetchStatus) ?? FETCH_STATUS.OK,
    fetchedAt: row.fetchedAt.toISOString(),
    ttlSeconds: row.ttlSeconds,
  };
}

/**
 * Perform a bounded outbound OpenGraph fetch.
 *
 * Wraps `open-graph-scraper` with a short timeout and a maximum body size.
 * On any error (network, non-2xx, oversize, parse failure), returns a
 * negative cache payload with `fetchStatus: 'error'` and a short detail string.
 */
async function fetchOpenGraph(urlString: string): Promise<{
  status: FetchStatus;
  fields: Partial<Pick<LinkPreviewPayload, 'ogTitle' | 'ogDescription' | 'ogImage' | 'siteName' | 'favicon' | 'ogType'>>;
  error?: string;
}> {
  try {
    // Dynamic import: open-graph-scraper is ESM and only needed server-side.
    const mod = await import('open-graph-scraper');
    const ogs = (mod as unknown as { default: typeof mod }).default ?? mod;
    const run = (ogs as unknown as (opts: object) => Promise<{
      error: boolean;
      result: Record<string, unknown>;
      response?: { statusCode?: number };
    }>);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_PREVIEW_FETCH_TIMEOUT_MS);
    try {
      const { error, result } = await run({
        url: urlString,
        timeout: LINK_PREVIEW_FETCH_TIMEOUT_MS,
        fetchOptions: {
          signal: controller.signal,
          headers: {
            // Identify as RIVR so well-behaved sites can include / exclude us
            // from their own policy.
            'User-Agent': 'RivrLinkPreviewBot/1.0 (+https://rivr.social/bots)',
            Accept: 'text/html,application/xhtml+xml',
          },
          // Abort after the cap even if the server trickles bytes.
          size: LINK_PREVIEW_MAX_BODY_BYTES,
        },
        maxRedirects: 3,
      });
      if (error) {
        return { status: FETCH_STATUS.ERROR, fields: {}, error: 'og_scraper_error' };
      }
      const pickString = (key: string): string | undefined => {
        const v = result[key];
        if (typeof v === 'string' && v.trim().length > 0) return v.trim();
        return undefined;
      };
      const pickImage = (): string | undefined => {
        const img = result.ogImage;
        if (Array.isArray(img) && img.length > 0) {
          const first = img[0] as { url?: string };
          if (first && typeof first.url === 'string') return first.url;
        }
        if (img && typeof img === 'object' && 'url' in (img as Record<string, unknown>)) {
          const u = (img as { url?: unknown }).url;
          if (typeof u === 'string') return u;
        }
        return pickString('ogImageURL');
      };
      const pickFavicon = (): string | undefined => {
        const fav = result.favicon;
        if (typeof fav === 'string') {
          // open-graph-scraper returns a path like '/favicon.ico'; resolve it
          // against the request URL so clients can render it directly.
          try {
            return new URL(fav, urlString).toString();
          } catch {
            return undefined;
          }
        }
        return undefined;
      };
      return {
        status: FETCH_STATUS.OK,
        fields: {
          ogTitle: pickString('ogTitle') ?? pickString('twitterTitle'),
          ogDescription:
            pickString('ogDescription') ?? pickString('twitterDescription') ?? pickString('dcDescription'),
          ogImage: pickImage(),
          siteName: pickString('ogSiteName'),
          ogType: pickString('ogType'),
          favicon: pickFavicon(),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: FETCH_STATUS.ERROR, fields: {}, error: message.slice(0, 200) };
  }
}

/**
 * Look up a local entity referenced by an internal RIVR URL (e.g. `/groups/<id>`)
 * and return a RIVR-native embed. Falls back to a minimal embed if the entity
 * isn't found, so clients can still render something useful.
 */
async function resolveInternalEmbed(rawUrl: string): Promise<ResourceEmbed> {
  const parsed = parseInternalSubspaceUrl(rawUrl);
  if (!parsed) {
    return { url: rawUrl, kind: 'internal' };
  }
  const { kind, id } = parsed;
  try {
    if (kind === 'profile' || kind === 'people') {
      // `/profile/[username]` uses a username; `/people/[id]` uses an agent id.
      // Try direct id first, fall back to a name lookup for usernames.
      const byId = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent =
        byId[0] ??
        (await db.select().from(agents).where(eq(agents.name, id)).limit(1))[0];
      if (agent) {
        return {
          url: rawUrl,
          kind: 'internal',
          ogTitle: agent.name,
          ogDescription: agent.description ?? undefined,
          ogImage: agent.image ?? undefined,
          siteName: 'RIVR',
        };
      }
    } else {
      // groups / rings / locales / events / posts / etc. live in `resources`.
      const rows = await db.select().from(resources).where(eq(resources.id, id)).limit(1);
      const r = rows[0];
      if (r) {
        return {
          url: rawUrl,
          kind: 'internal',
          ogTitle: r.name,
          ogDescription: r.description ?? undefined,
          siteName: 'RIVR',
        };
      }
    }
  } catch {
    // DB error — fall through to the minimal internal embed.
  }
  return { url: rawUrl, kind: 'internal', siteName: 'RIVR' };
}

/** Uniform error response helper. */
function errorJson(status: number, error: string, detail?: string): NextResponse {
  const body: ErrorResponse = { ok: false, error };
  if (detail) body.detail = detail;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/link-preview
 *
 * Request body: `{ url: string, ttlSeconds?: number }`.
 *
 * Response (200): `{ ok: true, preview: LinkPreviewPayload, cached: boolean }`.
 * Error responses carry `{ ok: false, error, detail? }`.
 *
 * @example
 * ```ts
 * const res = await fetch('/api/link-preview', {
 *   method: 'POST',
 *   body: JSON.stringify({ url: 'https://example.com' }),
 * });
 * const data = await res.json();
 * if (data.ok) attachToPost(data.preview);
 * ```
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Auth — only signed-in users may trigger outbound fetches.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return errorJson(STATUS_UNAUTHORIZED, 'unauthenticated');
  }

  // 2. Rate limit per-user (fall back to IP if somehow missing).
  const ip = getClientIp(request.headers);
  const rateKey = `link-preview:${userId || ip}`;
  const rl = await rateLimit(rateKey, LINK_PREVIEW_RATE_LIMIT.limit, LINK_PREVIEW_RATE_LIMIT.windowMs);
  if (!rl.success) {
    return errorJson(STATUS_TOO_MANY_REQUESTS, 'rate_limited');
  }

  // 3. Parse and validate body.
  let body: { url?: unknown; ttlSeconds?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(STATUS_BAD_REQUEST, 'invalid_json');
  }
  const urlRaw = typeof body.url === 'string' ? body.url.trim() : '';
  if (!urlRaw) {
    return errorJson(STATUS_BAD_REQUEST, 'missing_url');
  }
  const ttlSeconds = clampTtl(body.ttlSeconds);

  // 4. Pre-flight shape validation (protocol, hostname presence, blocked aliases).
  const shape = validateUrlShape(urlRaw);
  if (!shape.ok) {
    return errorJson(STATUS_BAD_REQUEST, 'invalid_url', shape.reason);
  }
  const normalized = shape.normalized;

  // 5. Internal subspace short-circuit — do not fetch our own origin.
  //    We treat any http(s) URL that begins with a RIVR subspace path as
  //    internal, even if the host is a federated peer. Cross-instance
  //    resolution via federation/query is a follow-up enhancement; we fall
  //    back to a minimal internal card in that case.
  const selfHost = request.headers.get('host')?.toLowerCase() ?? null;
  if (isInternalSubspaceUrl(urlRaw, selfHost)) {
    const internal = await resolveInternalEmbed(normalized);
    const now = new Date().toISOString();
    const payload: LinkPreviewPayload = {
      ...internal,
      fetchStatus: FETCH_STATUS.OK,
      fetchedAt: now,
      ttlSeconds,
    };
    const success: SuccessResponse = { ok: true, preview: payload, cached: false };
    return NextResponse.json(success, { status: STATUS_OK });
  }

  // 6. Cache lookup. Use the sha-256 of the normalized URL as the key.
  const hash = hashUrl(urlRaw);
  if (!hash) {
    return errorJson(STATUS_BAD_REQUEST, 'invalid_url', 'hash_failed');
  }
  try {
    const cached = await db
      .select()
      .from(linkPreviews)
      .where(eq(linkPreviews.urlHash, hash))
      .limit(1);
    const hit = cached[0];
    if (hit && isCacheFresh(hit.fetchedAt, hit.ttlSeconds)) {
      const success: SuccessResponse = {
        ok: true,
        preview: rowToPayload(hit),
        cached: true,
      };
      return NextResponse.json(success, { status: STATUS_OK });
    }

    // 7. SSRF guard — only reached for external URLs with no fresh cache.
    try {
      await assertSafeHost(shape.url.hostname);
    } catch {
      // Negative-cache the rejection so we don't re-resolve repeatedly.
      await persistPreview({
        hash,
        url: normalized,
        status: FETCH_STATUS.UNSUPPORTED,
        fields: {},
        error: 'ssrf_blocked',
        ttlSeconds,
      });
      return errorJson(STATUS_BAD_REQUEST, 'invalid_url', 'blocked_host');
    }

    // 8. Outbound OG fetch.
    const fetched = await fetchOpenGraph(normalized);
    const row = await persistPreview({
      hash,
      url: normalized,
      status: fetched.status,
      fields: fetched.fields,
      error: fetched.error,
      ttlSeconds,
    });
    const success: SuccessResponse = {
      ok: true,
      preview: rowToPayload(row),
      cached: false,
    };
    return NextResponse.json(success, { status: STATUS_OK });
  } catch (err) {
    const detail = err instanceof Error ? err.message : undefined;
    return errorJson(STATUS_INTERNAL_ERROR, 'server_error', detail);
  }
}

/**
 * Insert or update a preview row and return the stored record. Keeps the
 * cache keyed on `url_hash` (the primary key) so repeated requests for the
 * same URL reuse a single row.
 */
async function persistPreview(input: {
  hash: string;
  url: string;
  status: FetchStatus;
  fields: Partial<Pick<LinkPreviewPayload, 'ogTitle' | 'ogDescription' | 'ogImage' | 'siteName' | 'favicon' | 'ogType'>>;
  error?: string;
  ttlSeconds: number;
}): Promise<typeof linkPreviews.$inferSelect> {
  const now = new Date();
  const insertValues = {
    urlHash: input.hash,
    url: input.url,
    ogTitle: input.fields.ogTitle ?? null,
    ogDescription: input.fields.ogDescription ?? null,
    ogImage: input.fields.ogImage ?? null,
    ogSiteName: input.fields.siteName ?? null,
    ogType: input.fields.ogType ?? null,
    favicon: input.fields.favicon ?? null,
    fetchedAt: now,
    ttlSeconds: input.ttlSeconds,
    fetchStatus: input.status,
    fetchError: input.error ?? null,
  };
  const [row] = await db
    .insert(linkPreviews)
    .values(insertValues)
    .onConflictDoUpdate({
      target: linkPreviews.urlHash,
      set: {
        url: insertValues.url,
        ogTitle: insertValues.ogTitle,
        ogDescription: insertValues.ogDescription,
        ogImage: insertValues.ogImage,
        ogSiteName: insertValues.ogSiteName,
        ogType: insertValues.ogType,
        favicon: insertValues.favicon,
        fetchedAt: insertValues.fetchedAt,
        ttlSeconds: insertValues.ttlSeconds,
        fetchStatus: insertValues.fetchStatus,
        fetchError: insertValues.fetchError,
      },
    })
    .returning();
  return row;
}
