/**
 * Cross-platform reshare to connected outbound platforms (EPIC J9).
 *
 * Purpose:
 * A group can reshare its content (an offering, post, or event) OUTBOUND to the
 * external platforms it has connected via the generic
 * `group_outbound_connectors` lane (Discord, Slack, Twitter/X, …). EPIC J9 is
 * the outbound dispatch: build a platform-appropriate payload from the resource,
 * compute a stable idempotency key so the same content is never reshared twice
 * to the same platform, and hand off to a per-platform delivery adapter.
 *
 * This module holds the PURE reshare logic (supported platforms, payload
 * building, idempotency keys, adapter selection) separated from the
 * `@/db`-touching server action so it is unit-testable. Actual network delivery
 * is performed by platform adapters, which are credential-gated; the lane,
 * attribution, payload, and idempotency are complete here.
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

/** The kinds of resource that can be reshared. */
export const RESHAREABLE_RESOURCE_TYPES = ['offering', 'listing', 'post', 'event'] as const;
export type ReshareableResourceType = (typeof RESHAREABLE_RESOURCE_TYPES)[number];

/** Minimal resource facts needed to build a reshare payload. */
export interface ReshareSource {
  resourceId: string;
  resourceType: ReshareableResourceType;
  title: string;
  description?: string | null;
  /** Canonical public URL of the content on its home instance. */
  url: string;
}

/** A platform-agnostic, ready-to-deliver reshare payload. */
export interface ResharePayload {
  platform: ResharePlatform;
  /** Single-line headline for platforms with title fields. */
  title: string;
  /** Body text (already length-clamped to the platform's limit). */
  body: string;
  /** The link to include. */
  url: string;
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
 * The body combines the title and description, then is clamped to the
 * platform's character limit (ellipsized when truncated) so the downstream
 * adapter never has to worry about over-length content. The URL is always
 * carried separately so adapters can render it as a link/embed.
 *
 * @param groupId The resharing group's agent id (for the idempotency key).
 * @param platform The destination platform.
 * @param source The resource being reshared.
 * @returns A ready-to-deliver payload.
 */
export function buildResharePayload(
  groupId: string,
  platform: ResharePlatform,
  source: ReshareSource,
): ResharePayload {
  const limit = PLATFORM_BODY_LIMITS[platform];
  const description = source.description?.trim() ?? '';
  const rawBody = description ? `${source.title.trim()} — ${description}` : source.title.trim();
  const body = clampText(rawBody, limit);

  return {
    platform,
    title: source.title.trim(),
    body,
    url: source.url,
    idempotencyKey: reshareIdempotencyKey(groupId, platform, source.resourceId),
  };
}

/** Clamps text to `max` chars, appending an ellipsis when truncated. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Outcome of a single platform delivery attempt. */
export interface ReshareDeliveryResult {
  platform: ResharePlatform;
  delivered: boolean;
  /** Why delivery did not happen (e.g. adapter not configured). */
  reason?: string;
  /** Adapter-returned external id/url, when delivered. */
  externalRef?: string;
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
 * Returns whether a connector carries the minimum credentials its platform
 * needs to actually deliver. Used to decide between a real delivery and an
 * `adapter not configured` no-op (the lane + attribution still record the
 * reshare intent either way).
 */
export function connectorCanDeliver(
  platform: ResharePlatform,
  credentials: ReshareConnectorCredentials,
): boolean {
  switch (platform) {
    case 'discord':
    case 'slack':
    case 'webhook':
      return typeof credentials.webhookUrl === 'string' && credentials.webhookUrl.length > 0;
    case 'twitter':
    case 'mastodon':
      return (
        typeof credentials.accessToken === 'string' && credentials.accessToken.length > 0
      );
    default:
      return false;
  }
}
