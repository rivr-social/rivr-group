export interface OutboundUrlPolicy {
  protocols?: readonly string[];
  allowedHostnames?: readonly string[];
  allowedHostnameSuffixes?: readonly string[];
  allowLocalhost?: boolean;
  allowPrivateIpLiterals?: boolean;
}

const DEFAULT_PROTOCOLS = ["https:"] as const;

export function assertSafeOutboundUrl(input: string | URL, policy: OutboundUrlPolicy = {}): URL {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(input.trim());
  const protocols = policy.protocols ?? DEFAULT_PROTOCOLS;

  if (!protocols.includes(url.protocol)) {
    throw new Error(`Outbound URL must use one of: ${protocols.join(", ")}`);
  }

  if (url.username || url.password) {
    throw new Error("Outbound URL must not include embedded credentials.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new Error("Outbound URL must include a hostname.");
  }

  if (!policy.allowLocalhost && isLocalhost(hostname)) {
    throw new Error("Outbound URL must not target localhost.");
  }

  if (!policy.allowPrivateIpLiterals && isPrivateIpLiteral(hostname)) {
    throw new Error("Outbound URL must not target a private or local IP address.");
  }

  const allowedHostnames = new Set((policy.allowedHostnames ?? []).map(normalizeHostname));
  const allowedSuffixes = (policy.allowedHostnameSuffixes ?? []).map(normalizeHostname);
  const hasHostAllowlist = allowedHostnames.size > 0 || allowedSuffixes.length > 0;

  if (hasHostAllowlist) {
    const isAllowed =
      allowedHostnames.has(hostname) ||
      allowedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));

    if (!isAllowed) {
      throw new Error("Outbound URL hostname is not allowed.");
    }
  }

  return url;
}

export function safeOutboundUrlString(input: string | URL, policy: OutboundUrlPolicy = {}): string {
  return assertSafeOutboundUrl(input, policy).toString();
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function isPrivateIpLiteral(hostname: string): boolean {
  return isPrivateIpv4(hostname) || isPrivateIpv6(hostname);
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some(Number.isNaN)) return false;

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:169.254.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}
