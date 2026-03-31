/**
 * Extracts client IP with defense-in-depth against header spoofing.
 *
 * When behind a trusted reverse proxy (Nginx/Caddy on Docker Lab),
 * X-Real-IP is set by the proxy and harder to spoof. For X-Forwarded-For,
 * we take the LAST entry (proxy-added) rather than the first (user-controlled).
 */
export function getClientIp(headerList: Headers): string {
  // X-Real-IP is set by the reverse proxy — preferred and hardest to spoof
  const realIp = headerList.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  // Cloudflare's connecting IP header (if using CF)
  const cfIp = headerList.get("cf-connecting-ip");
  if (cfIp && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  // Fallback: take the LAST entry in X-Forwarded-For (closest to the proxy)
  // rather than the first (which is user-controlled and spoofable)
  const xff = headerList.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  return "unknown";
}
