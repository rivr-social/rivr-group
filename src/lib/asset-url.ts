/**
 * Asset URL normalization helpers.
 *
 * Purpose:
 * - Keep server-side object storage endpoints internal (e.g. minio:9000),
 *   while ensuring browser-facing URLs use a public origin (e.g. s3.<domain>).
 * - Repair legacy internal MinIO URLs at read-time so existing records keep
 *   rendering after production hardening.
 */

const INTERNAL_MINIO_HOSTS = new Set(["minio", "rivr-minio", "localhost", "127.0.0.1"]);

function getPublicAssetBaseUrl(): string | null {
  const explicit = process.env.ASSET_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_MINIO_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const domain = process.env.NEXT_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://s3.${domain}`;

  return null;
}

/**
 * Normalizes internal object-storage URLs to a public URL base when configured.
 *
 * @param value URL-like string to normalize.
 * @returns Original value when no rewrite applies, otherwise rewritten public URL.
 */
export function normalizeAssetUrl(value: string | null | undefined): string {
  if (!value) return "";
  const input = value.trim();
  if (!input) return "";

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  const publicBase = getPublicAssetBaseUrl();
  if (!publicBase) return input;

  const isInternalMinio =
    INTERNAL_MINIO_HOSTS.has(parsed.hostname.toLowerCase()) && parsed.port === "9000";
  if (!isInternalMinio) return input;

  return `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

