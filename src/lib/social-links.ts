/**
 * Social-links validation, normalization, and metadata-merge helpers.
 *
 * Purpose:
 * - Provide a single, pure (side-effect-free) source of truth for how external
 *   social-media handles / links are validated and normalized before they are
 *   persisted into an agent's `metadata.socialLinks` map.
 * - Used by BOTH first-class user profiles (`updateProfileAction`) and groups
 *   (`updateGroupResource` via the group edit surface) so the two entity types
 *   share identical validation rules.
 *
 * Storage model (matched to existing convention):
 * - Social links live in `agents.metadata.socialLinks` as a flat
 *   `Record<platform, value>` map (e.g. `{ website: "https://...", x: "..." }`).
 * - For users, a subset is ALSO dual-written to dedicated columns by
 *   `updateProfileAction`; this module only owns the metadata-map shape and its
 *   validation — it does not touch columns.
 *
 * Security / trust:
 * - These functions never read identity. The caller (a server action) derives
 *   the owner from `auth()` and passes only the link payload here. This keeps
 *   owner authority server-side per the verified-principal model.
 * - URL-bearing platforms are constrained to http/https and to the platform's
 *   own host allowlist where one exists (e.g. Instagram links must point at
 *   instagram.com) to prevent open-redirect / phishing-style link injection.
 *
 * Key exports:
 * - `SOCIAL_PLATFORMS` — canonical platform metadata (order, kind, host rules).
 * - `isSupportedSocialPlatform`
 * - `normalizeSocialLinkValue` — normalize a single value for a platform.
 * - `validateSocialLinks` — validate+normalize a whole map, reporting errors.
 * - `mergeSocialLinksIntoMetadata` — merge a validated map into existing
 *   metadata, preserving unknown keys.
 */

/** Discriminates how a platform's value is interpreted and normalized. */
export type SocialPlatformKind = "url" | "tel" | "email";

/** Canonical descriptor for a single supported social platform. */
export interface SocialPlatformDescriptor {
  /** Stable key persisted in `metadata.socialLinks` (lowercase). */
  readonly key: string;
  /** Human-readable label (kept in sync with `social-platform-icon.tsx`). */
  readonly label: string;
  /** Value interpretation. */
  readonly kind: SocialPlatformKind;
  /**
   * For `kind === "url"`: optional allowlist of acceptable host suffixes.
   * When present, the normalized URL's host must end with one of these.
   * `website` has no host constraint (any http/https host is allowed).
   */
  readonly hostSuffixes?: readonly string[];
}

/**
 * Canonical, ordered list of supported social platforms. The order here is the
 * order surfaced in the editor select. Keys MUST stay lowercase and match the
 * icon/label helpers in `social-platform-icon.tsx`.
 */
export const SOCIAL_PLATFORMS: readonly SocialPlatformDescriptor[] = [
  { key: "website", label: "Website", kind: "url" },
  { key: "x", label: "X (Twitter)", kind: "url", hostSuffixes: ["x.com", "twitter.com"] },
  { key: "instagram", label: "Instagram", kind: "url", hostSuffixes: ["instagram.com"] },
  { key: "linkedin", label: "LinkedIn", kind: "url", hostSuffixes: ["linkedin.com"] },
  { key: "telegram", label: "Telegram", kind: "url", hostSuffixes: ["t.me", "telegram.me", "telegram.org"] },
  { key: "signal", label: "Signal", kind: "url", hostSuffixes: ["signal.me", "signal.group"] },
  { key: "phone", label: "Phone", kind: "tel" },
  { key: "email", label: "Email", kind: "email" },
];

/** Map of platform key → descriptor for O(1) lookups. */
const PLATFORM_BY_KEY: Record<string, SocialPlatformDescriptor> = Object.fromEntries(
  SOCIAL_PLATFORMS.map((platform) => [platform.key, platform])
);

/** Maximum stored length for any single social-link value. */
export const MAX_SOCIAL_LINK_LENGTH = 2048;

/** Maximum number of distinct social links an entity may store. */
export const MAX_SOCIAL_LINKS = SOCIAL_PLATFORMS.length;

/** Accepted URL protocols for `url`-kind platforms. */
const ALLOWED_URL_PROTOCOLS = ["http:", "https:"] as const;

/** Permissive-but-bounded email shape check (server-side, not RFC-exhaustive). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strips characters that are never valid in a dialable phone number. */
const PHONE_STRIP_RE = /[^0-9+().\-\s]/g;

/** A validation problem for a single platform entry. */
export interface SocialLinkError {
  readonly platform: string;
  readonly message: string;
}

/** Result of validating/normalizing a full social-links map. */
export interface SocialLinksValidationResult {
  /** Normalized, valid entries only (invalid/empty entries are dropped). */
  readonly socialLinks: Record<string, string>;
  /** Per-entry validation errors (empty when fully valid). */
  readonly errors: SocialLinkError[];
}

/** Returns true when `platform` is a recognized social platform key. */
export function isSupportedSocialPlatform(platform: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_BY_KEY, platform.toLowerCase());
}

/** Returns the descriptor for a platform key, or `undefined` if unsupported. */
export function getSocialPlatform(platform: string): SocialPlatformDescriptor | undefined {
  return PLATFORM_BY_KEY[platform.toLowerCase()];
}

/** Outcome of normalizing a single value. */
type NormalizeOutcome =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Normalizes a single `url`-kind value: trims, prepends `https://` when the
 * value has no scheme, parses it, enforces http/https, and (when the platform
 * declares `hostSuffixes`) enforces the platform's host allowlist.
 */
function normalizeUrlValue(descriptor: SocialPlatformDescriptor, raw: string): NormalizeOutcome {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: `${descriptor.label} link is not a valid URL.` };
  }

  if (!ALLOWED_URL_PROTOCOLS.includes(url.protocol as (typeof ALLOWED_URL_PROTOCOLS)[number])) {
    return { ok: false, message: `${descriptor.label} link must use http or https.` };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (descriptor.hostSuffixes && descriptor.hostSuffixes.length > 0) {
    const allowed = descriptor.hostSuffixes.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
    if (!allowed) {
      return {
        ok: false,
        message: `${descriptor.label} link must point to ${descriptor.hostSuffixes.join(" or ")}.`,
      };
    }
  }

  const normalized = url.toString();
  if (normalized.length > MAX_SOCIAL_LINK_LENGTH) {
    return { ok: false, message: `${descriptor.label} link is too long.` };
  }
  return { ok: true, value: normalized };
}

/** Normalizes a single `tel`-kind value (digits/format chars only). */
function normalizeTelValue(descriptor: SocialPlatformDescriptor, raw: string): NormalizeOutcome {
  const cleaned = raw.replace(PHONE_STRIP_RE, "").trim();
  const digitCount = (cleaned.match(/\d/g) ?? []).length;
  if (digitCount < 5) {
    return { ok: false, message: `${descriptor.label} number looks too short.` };
  }
  if (cleaned.length > MAX_SOCIAL_LINK_LENGTH) {
    return { ok: false, message: `${descriptor.label} number is too long.` };
  }
  return { ok: true, value: cleaned };
}

/** Normalizes a single `email`-kind value (lowercased, shape-checked). */
function normalizeEmailValue(descriptor: SocialPlatformDescriptor, raw: string): NormalizeOutcome {
  const cleaned = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(cleaned)) {
    return { ok: false, message: `${descriptor.label} address is not valid.` };
  }
  if (cleaned.length > MAX_SOCIAL_LINK_LENGTH) {
    return { ok: false, message: `${descriptor.label} address is too long.` };
  }
  return { ok: true, value: cleaned };
}

/**
 * Validates and normalizes a single social-link value for a known platform.
 *
 * @param platform Platform key (case-insensitive).
 * @param value Raw user-supplied value.
 * @returns `{ ok: true, value }` with the normalized value, or
 *   `{ ok: false, message }` describing why it was rejected. Unsupported
 *   platforms are rejected.
 */
export function normalizeSocialLinkValue(platform: string, value: string): NormalizeOutcome {
  const descriptor = getSocialPlatform(platform);
  if (!descriptor) {
    return { ok: false, message: `"${platform}" is not a supported social platform.` };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${descriptor.label} value is empty.` };
  }
  switch (descriptor.kind) {
    case "url":
      return normalizeUrlValue(descriptor, value);
    case "tel":
      return normalizeTelValue(descriptor, value);
    case "email":
      return normalizeEmailValue(descriptor, value);
    default:
      return { ok: false, message: `Unsupported platform kind.` };
  }
}

/**
 * Validates and normalizes a whole social-links map.
 *
 * Behaviour:
 * - Empty/blank values are silently dropped (treated as "removed").
 * - Unknown platforms produce an error and are dropped.
 * - Invalid values for known platforms produce an error and are dropped.
 * - The number of valid entries is capped at `MAX_SOCIAL_LINKS`.
 *
 * @param input Arbitrary platform→value map (untrusted client input).
 * @returns Normalized valid entries plus any per-entry errors.
 */
export function validateSocialLinks(
  input: Record<string, unknown> | null | undefined
): SocialLinksValidationResult {
  const socialLinks: Record<string, string> = {};
  const errors: SocialLinkError[] = [];

  if (!input || typeof input !== "object") {
    return { socialLinks, errors };
  }

  for (const [rawPlatform, rawValue] of Object.entries(input)) {
    const platform = rawPlatform.toLowerCase();
    // Blank values mean "no link for this platform" — drop without error.
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    if (Object.keys(socialLinks).length >= MAX_SOCIAL_LINKS) {
      errors.push({ platform, message: `Only ${MAX_SOCIAL_LINKS} social links are allowed.` });
      continue;
    }
    const outcome = normalizeSocialLinkValue(platform, rawValue);
    if (outcome.ok) {
      socialLinks[platform] = outcome.value;
    } else {
      errors.push({ platform, message: outcome.message });
    }
  }

  return { socialLinks, errors };
}

/**
 * Merges a validated social-links map into an existing metadata object,
 * preserving all unrelated metadata keys. Returns a NEW object; inputs are not
 * mutated. The merge REPLACES the entire `socialLinks` map (so removals stick).
 *
 * @param existingMetadata The agent's current metadata (any shape).
 * @param socialLinks A validated, normalized social-links map.
 * @returns New metadata object with `socialLinks` set.
 */
export function mergeSocialLinksIntoMetadata(
  existingMetadata: Record<string, unknown> | null | undefined,
  socialLinks: Record<string, string>
): Record<string, unknown> {
  const base =
    existingMetadata && typeof existingMetadata === "object" ? { ...existingMetadata } : {};
  return { ...base, socialLinks };
}

/**
 * Reads a social-links map out of arbitrary metadata, tolerating both the
 * canonical `socialLinks` key and the snake_case `social_links` alias used by
 * some federated payloads. Non-string values are dropped.
 */
export function readSocialLinksFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, string> {
  if (!metadata || typeof metadata !== "object") return {};
  const raw = (metadata.socialLinks ?? (metadata as Record<string, unknown>).social_links) as unknown;
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}
