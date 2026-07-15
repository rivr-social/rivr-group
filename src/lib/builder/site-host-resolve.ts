/**
 * @fileoverview Pure host-dispatch resolution + DNS verification for published
 * builder sites (ported from the person app, adapted to this app's DB-snapshot
 * serving — a publication is servable via its `publishedVersionId`, not MinIO
 * storage coordinates). NO database imports live here (only node:dns), so these
 * helpers are hermetically unit-testable.
 *
 *   - {@link matchPublicationForHost}  maps a Host header to the bound
 *     publication that should serve it (unknown host -> null).
 *   - {@link computeDomainVerification} / {@link verifyDomainPointsToApp}
 *     decide whether a custom domain resolves to this instance's app host.
 */
import { promises as dnsPromises } from "node:dns";

// ---------------------------------------------------------------------------
// Domain status constants
// ---------------------------------------------------------------------------

export const DOMAIN_STATUS_UNBOUND = "unbound";
export const DOMAIN_STATUS_PENDING = "pending";
export const DOMAIN_STATUS_BOUND = "bound";
export const DOMAIN_STATUS_ERROR = "error";

/** Domain statuses whose publication is servable via host-dispatch. */
export const SERVABLE_DOMAIN_STATUSES: ReadonlySet<string> = new Set([DOMAIN_STATUS_BOUND]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Specific error for domain verification failures (pure layer). */
export class DomainVerifyError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainVerifyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Host normalization + matching
// ---------------------------------------------------------------------------

/** Lowercases a host, strips any port and trailing dot. */
export function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/\.$/, "").split(":")[0] ?? "";
}

/** Minimal publication shape the host matcher needs (DB-snapshot serving). */
export interface ServablePublication {
  customDomain: string | null;
  domainStatus: string;
  publishedVersionId: string | null;
}

/**
 * Selects the publication that should serve `host` from a candidate list. A
 * publication matches when its bound `customDomain` equals the normalized host,
 * its status is servable, and it has a published version to serve. Returns
 * null when no candidate matches (unknown host -> null).
 */
export function matchPublicationForHost<T extends ServablePublication>(
  host: string,
  publications: T[],
): T | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  for (const pub of publications) {
    if (
      pub.customDomain &&
      normalizeHost(pub.customDomain) === normalized &&
      SERVABLE_DOMAIN_STATUSES.has(pub.domainStatus) &&
      pub.publishedVersionId
    ) {
      return pub;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// App hostname + DNS verification
// ---------------------------------------------------------------------------

/** Resolves the app's own hostname from instance/base-url env. */
export function getAppHostname(): string | null {
  const url =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXTAUTH_URL ||
    "";
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Outcome of comparing a domain's resolved addresses to the app's. */
export interface DomainVerification {
  verified: boolean;
  /** Addresses the domain and the app host share. */
  matched: string[];
  appAddresses: string[];
  domainAddresses: string[];
  detail: string;
}

/**
 * Pure verification: a domain points at the app when it CNAMEs the app host, or
 * when its resolved A/AAAA addresses intersect the app host's addresses.
 */
export function computeDomainVerification(
  appHostname: string,
  appAddresses: string[],
  domainAddresses: string[],
  domainCnames: string[],
): DomainVerification {
  const appHost = normalizeHost(appHostname);
  const cnameMatch = domainCnames.some((cname) => normalizeHost(cname) === appHost);
  const appSet = new Set(appAddresses);
  const matched = domainAddresses.filter((addr) => appSet.has(addr));
  const verified = cnameMatch || matched.length > 0;

  let detail: string;
  if (verified && cnameMatch) {
    detail = `Domain CNAMEs the app host (${appHost}).`;
  } else if (verified) {
    detail = `Domain resolves to the app host address(es): ${matched.join(", ")}.`;
  } else if (domainAddresses.length === 0 && domainCnames.length === 0) {
    detail = `No A/AAAA/CNAME records found. Point the domain at the same address as ${appHost}.`;
  } else {
    const found = [
      ...domainAddresses.map((a) => `A/AAAA: ${a}`),
      ...domainCnames.map((c) => `CNAME: ${c}`),
    ].join(", ");
    detail = `Domain resolves to ${found}, but the app host ${appHost} resolves to ${appAddresses.join(", ") || "no addresses"}. Update the record.`;
  }
  return { verified, matched, appAddresses, domainAddresses, detail };
}

/** The DNS surface the verifier needs; injectable so tests avoid real lookups. */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

async function safeResolve(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/** node:dns-backed resolver that degrades to [] on ENODATA/ENOTFOUND. */
export const defaultDnsResolver: DnsResolver = {
  resolve4: (h) => safeResolve(() => dnsPromises.resolve4(h)),
  resolve6: (h) => safeResolve(() => dnsPromises.resolve6(h)),
  resolveCname: (h) => safeResolve(() => dnsPromises.resolveCname(h)),
};

/**
 * Verifies a custom domain points at this app. Resolves the app host's A/AAAA
 * addresses and the domain's A/AAAA/CNAME records, then delegates the decision
 * to {@link computeDomainVerification}. `resolver` is injectable for tests.
 *
 * @throws {DomainVerifyError} When the app hostname cannot be determined.
 */
export async function verifyDomainPointsToApp(
  domain: string,
  resolver: DnsResolver = defaultDnsResolver,
  appHostnameOverride?: string,
): Promise<DomainVerification> {
  const appHostname = appHostnameOverride ?? getAppHostname();
  if (!appHostname) {
    throw new DomainVerifyError(
      "NO_APP_HOST",
      "The app hostname is not configured on this instance.",
    );
  }
  const target = normalizeHost(domain);
  const [app4, app6, domain4, domain6, domainCnames] = await Promise.all([
    resolver.resolve4(appHostname),
    resolver.resolve6(appHostname),
    resolver.resolve4(target),
    resolver.resolve6(target),
    resolver.resolveCname(target),
  ]);
  return computeDomainVerification(
    appHostname,
    [...app4, ...app6],
    [...domain4, ...domain6],
    domainCnames,
  );
}
