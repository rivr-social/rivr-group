/**
 * Cross-platform reshare to connected outbound platforms (EPIC J9).
 *
 * Purpose:
 * A user can RESHARE a group's content (an offering, post, or event) outbound to
 * external platforms. EPIC J9's reworked contract:
 *
 *  1. USER-INITIATED, never automatic. Nothing here is triggered by a cron, a
 *     create hook, or any auto-dispatch. A person explicitly chooses to reshare.
 *  2. NO assumed API push for every platform. Each platform declares a delivery
 *     MODE: `api` (a real outbound push is available) or `share-intent` /
 *     `copy-link` / `composer` (the user completes the share themselves — the
 *     payload + a pre-built share-intent URL are handed back, NO silent network
 *     dispatch happens).
 *  3. MANDATORY BACKLINK. Every reshared payload MUST carry a clickable link
 *     back to the ORIGINAL post/event/offering's canonical RIVR URL. The link is
 *     required (an empty url throws) and is embedded INTO the body text so it is
 *     clickable even on platforms that don't render a separate url field.
 *
 * This module holds the PURE reshare logic (platforms, delivery modes, payload
 * building, share-intent URLs, idempotency keys, adapter credential gate),
 * separated from the `@/db`-touching server action so it is unit-testable. It
 * NEVER performs network I/O.
 */

/** External platforms a group may reshare content to. */
export const SUPPORTED_RESHARE_PLATFORMS = [
  'discord',
  'slack',
  'twitter',
  'mastodon',
  'webhook',
] as const;

export type ResharePlatform = (typeof SUPPORTED_RESHARE_PLATFORMS)[number];

/**
 * How a reshare reaches a platform:
 *  - `api`: a real outbound push is possible IF the connector carries
 *    credentials. The user still initiates it; nothing auto-fires.
 *  - `share-intent`: no server push — we hand back a pre-built share-intent URL
 *    the user opens to complete the share in the platform's own composer.
 *  - `copy-link`: no push, no intent — the user copies the payload/backlink.
 */
export type ReshareDeliveryMode = 'api' | 'share-intent' | 'copy-link';

/**
 * The delivery mode for each platform. We do NOT assume an API push exists for
 * every platform: only true webhook/API platforms are `api`; consumer social
 * platforms use a user-completed share-intent so we never silently dispatch.
 */
export const PLATFORM_DELIVERY_MODE: Record<ResharePlatform, ReshareDeliveryMode> = {
  // Server-to-server push targets (webhook / bot / API token).
  discord: 'api',
  slack: 'api',
  webhook: 'api',
  // Consumer platforms: user completes the share via the platform composer.
  twitter: 'share-intent',
  mastodon: 'share-intent',
};

/** Returns the delivery mode for a platform. */
export function reshareDeliveryMode(platform: ResharePlatform): ReshareDeliveryMode {
  return PLATFORM_DELIVERY_MODE[platform];
}

/** The kinds of resource that can be reshared. */
export const RESHAREABLE_RESOURCE_TYPES = ['offering', 'listing', 'post', 'event'] as const;
export type ReshareableResourceType = (typeof RESHAREABLE_RESOURCE_TYPES)[number];

/** Minimal resource facts needed to build a reshare payload. */
export interface ReshareSource {
  resourceId: string;
  resourceType: ReshareableResourceType;
  title: string;
  description?: string | null;
  /**
   * Canonical public URL of the ORIGINAL content on its home instance. This is
   * the mandatory backlink every reshared payload must carry; for a federated
   * mirror it MUST be the source instance's canonical URL, never the local copy.
   * An empty/whitespace url is rejected by {@link buildResharePayload}.
   */
  url: string;
}

/** A platform-agnostic reshare payload (no network I/O has occurred). */
export interface ResharePayload {
  platform: ResharePlatform;
  /** How this reshare reaches the platform (api / share-intent / copy-link). */
  deliveryMode: ReshareDeliveryMode;
  /** Single-line headline for platforms with title fields. */
  title: string;
  /**
   * Body text — already length-clamped to the platform's limit AND guaranteed to
   * end with the clickable canonical backlink URL.
   */
  body: string;
  /** The mandatory canonical backlink to the ORIGINAL content. */
  url: string;
  /**
   * For `share-intent` platforms, a pre-built URL the USER opens to complete the
   * share in the platform's own composer (no server dispatch). Absent for `api`
   * and `copy-link` platforms.
   */
  shareIntentUrl?: string;
  /** Stable key deduping (groupId, platform, resourceId) deliveries. */
  idempotencyKey: string;
}

/** Per-platform body length caps (conservative, char-based). */
const PLATFORM_BODY_LIMITS: Record<ResharePlatform, number> = {
  twitter: 240,
  mastodon: 480,
  discord: 1800,
  slack: 2800,
  webhook: 4000,
};

/** Narrows an arbitrary string to a supported platform, or `null`. */
export function normalizeResharePlatform(value: unknown): ResharePlatform | null {
  return typeof value === 'string' &&
    (SUPPORTED_RESHARE_PLATFORMS as readonly string[]).includes(value)
    ? (value as ResharePlatform)
    : null;
}

/** Returns whether a resource type is eligible for reshare. */
export function isReshareableResourceType(
  value: unknown,
): value is ReshareableResourceType {
  return (
    typeof value === 'string' &&
    (RESHAREABLE_RESOURCE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Computes the stable idempotency key for a reshare. The same (group, platform,
 * resource) triple always yields the same key, so a connector that has already
 * delivered a piece of content is never asked to deliver it again.
 */
export function reshareIdempotencyKey(
  groupId: string,
  platform: ResharePlatform,
  resourceId: string,
): string {
  return `reshare:${groupId}:${platform}:${resourceId}`;
}

/**
 * Builds a platform-appropriate reshare payload from a source resource.
 *
 * The title + description are clamped to leave room for the MANDATORY canonical
 * backlink, which is then appended so the body always ENDS with the clickable
 * link to the original content (carried separately in `url` too, for platforms
 * with a dedicated link/embed field). For `share-intent` platforms a pre-built
 * composer URL is also returned. No network I/O occurs here.
 *
 * @param groupId The resharing group's agent id (for the idempotency key).
 * @param platform The destination platform.
 * @param source The resource being reshared; `source.url` is the REQUIRED
 *   canonical backlink to the original content.
 * @returns A payload whose body always contains the backlink URL.
 * @throws {Error} When `source.url` is missing/blank — a reshare without a
 *   backlink to the original is not permitted.
 */
export function buildResharePayload(
  groupId: string,
  platform: ResharePlatform,
  source: ReshareSource,
): ResharePayload {
  const url = source.url?.trim() ?? '';
  if (url.length === 0) {
    throw new Error(
      `reshare payload requires a canonical backlink url for resource ${source.resourceId}`,
    );
  }

  const limit = PLATFORM_BODY_LIMITS[platform];
  const description = source.description?.trim() ?? '';
  const headline = description
    ? `${source.title.trim()} — ${description}`
    : source.title.trim();

  // Reserve room for "\n\n" + the backlink so the URL is never truncated away.
  const suffix = `\n\n${url}`;
  const textBudget = Math.max(0, limit - suffix.length);
  const clampedHeadline = clampText(headline, textBudget);
  const body = `${clampedHeadline}${suffix}`;

  const deliveryMode = reshareDeliveryMode(platform);
  const shareIntentUrl =
    deliveryMode === 'share-intent'
      ? buildShareIntentUrl(platform, clampedHeadline, url)
      : undefined;

  return {
    platform,
    deliveryMode,
    title: source.title.trim(),
    body,
    url,
    shareIntentUrl,
    idempotencyKey: reshareIdempotencyKey(groupId, platform, source.resourceId),
  };
}

/**
 * Builds a user-completed share-intent URL for `share-intent` platforms. Opening
 * it drops the user into the platform's own composer pre-filled with the text
 * and the canonical backlink — no server-side network dispatch occurs.
 */
export function buildShareIntentUrl(
  platform: ResharePlatform,
  text: string,
  url: string,
): string {
  switch (platform) {
    case 'twitter': {
      const params = new URLSearchParams({ text, url });
      return `https://twitter.com/intent/tweet?${params.toString()}`;
    }
    case 'mastodon': {
      // Mastodon's share intent takes a single combined `text` param.
      const params = new URLSearchParams({ text: `${text} ${url}`.trim() });
      return `https://mastodon.social/share?${params.toString()}`;
    }
    default:
      // Non-share-intent platforms have no composer URL.
      return url;
  }
}

/** Clamps text to `max` chars, appending an ellipsis when truncated. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Outcome of preparing a reshare for a single platform. */
export interface ReshareDeliveryResult {
  platform: ResharePlatform;
  /** How the reshare was/will be completed for this platform. */
  deliveryMode: ReshareDeliveryMode;
  /**
   * True ONLY for `api`-mode platforms whose credentials let the server push.
   * `share-intent`/`copy-link` platforms are never auto-delivered — the user
   * completes them — so this is false with a `share-intent` reason.
   */
  delivered: boolean;
  /** Why delivery did not happen (e.g. user-completed mode, no credentials). */
  reason?: string;
  /** Adapter-returned external id/url, when delivered. */
  externalRef?: string;
  /** Pre-built composer URL surfaced to the user for `share-intent` platforms. */
  shareIntentUrl?: string;
}

/**
 * The minimal credential shape a platform adapter needs. Different platforms use
 * different subsets (webhook URL vs bot token + channel id vs access token).
 */
export interface ReshareConnectorCredentials {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  accessToken?: string;
  [key: string]: unknown;
}

/**
 * Returns whether a connector can be PUSHED to by the server. Only `api`-mode
 * platforms carrying their required credentials can deliver; `share-intent` and
 * `copy-link` platforms are user-completed and therefore never server-delivered,
 * so this always returns false for them (no silent network dispatch).
 */
export function connectorCanDeliver(
  platform: ResharePlatform,
  credentials: ReshareConnectorCredentials,
): boolean {
  // Non-API platforms are user-completed; the server never pushes them.
  if (reshareDeliveryMode(platform) !== 'api') return false;
  switch (platform) {
    case 'discord':
    case 'slack':
    case 'webhook':
      return typeof credentials.webhookUrl === 'string' && credentials.webhookUrl.length > 0;
    default:
      return false;
  }
}
