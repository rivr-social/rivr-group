/**
 * Validates a redirect URL to prevent open redirect attacks.
 * Only allows relative paths starting with "/" that don't contain protocol markers.
 * Returns "/" as fallback for any invalid or external URL.
 */
export function safeRedirectUrl(url: string | null | undefined): string {
  if (!url || typeof url !== "string") return "/";
  const trimmed = url.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("://") ||
    trimmed.toLowerCase().startsWith("/\\")
  ) {
    return "/";
  }
  return trimmed;
}
