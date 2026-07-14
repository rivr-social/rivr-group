/**
 * Unit tests for the pure custom-domain lane: host normalization, publication
 * matching (DB-snapshot shape), DNS verification math, and the shared serve
 * helpers. Hermetic — the DNS resolver is injected, no DB imports.
 */
import { describe, expect, it } from "vitest";
import {
  DOMAIN_STATUS_BOUND,
  DOMAIN_STATUS_PENDING,
  DOMAIN_STATUS_UNBOUND,
  DomainVerifyError,
  computeDomainVerification,
  matchPublicationForHost,
  normalizeHost,
  verifyDomainPointsToApp,
  type DnsResolver,
  type ServablePublication,
} from "@/lib/builder/site-host-resolve";
import { contentTypeFor, resolveSitePath, withSiteBase } from "@/lib/builder/site-serve";

// ---------------------------------------------------------------------------
// normalizeHost
// ---------------------------------------------------------------------------

describe("normalizeHost", () => {
  it("lowercases, strips port and trailing dot", () => {
    expect(normalizeHost("Example.COM:443")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("  WWW.Example.com  ")).toBe("www.example.com");
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Host-dispatch resolution (DB-snapshot shape)
// ---------------------------------------------------------------------------

describe("matchPublicationForHost", () => {
  const bound: ServablePublication = {
    customDomain: "mutual-aid.example.org",
    domainStatus: DOMAIN_STATUS_BOUND,
    publishedVersionId: "v-1",
  };

  it("matches a bound publication with a live version", () => {
    expect(matchPublicationForHost("Mutual-Aid.Example.org:443", [bound])).toBe(bound);
  });

  it("rejects a pending/unbound status", () => {
    expect(
      matchPublicationForHost("mutual-aid.example.org", [
        { ...bound, domainStatus: DOMAIN_STATUS_PENDING },
        { ...bound, domainStatus: DOMAIN_STATUS_UNBOUND },
      ]),
    ).toBeNull();
  });

  it("rejects a bound domain with no published version", () => {
    expect(
      matchPublicationForHost("mutual-aid.example.org", [
        { ...bound, publishedVersionId: null },
      ]),
    ).toBeNull();
  });

  it("rejects an unknown host and an empty host", () => {
    expect(matchPublicationForHost("other.example.org", [bound])).toBeNull();
    expect(matchPublicationForHost("", [bound])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DNS verification math
// ---------------------------------------------------------------------------

describe("computeDomainVerification", () => {
  it("verifies on an address intersection", () => {
    const result = computeDomainVerification("app.example.org", ["1.2.3.4"], ["1.2.3.4"], []);
    expect(result.verified).toBe(true);
    expect(result.matched).toEqual(["1.2.3.4"]);
  });

  it("verifies on a CNAME to the app host (case-insensitive)", () => {
    const result = computeDomainVerification("app.example.org", ["1.2.3.4"], [], [
      "App.Example.ORG.",
    ]);
    expect(result.verified).toBe(true);
  });

  it("fails with guidance when nothing resolves", () => {
    const result = computeDomainVerification("app.example.org", ["1.2.3.4"], [], []);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain("No A/AAAA/CNAME records");
  });

  it("fails with a mismatch detail when addresses differ", () => {
    const result = computeDomainVerification("app.example.org", ["1.2.3.4"], ["5.6.7.8"], []);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain("5.6.7.8");
  });
});

describe("verifyDomainPointsToApp", () => {
  const resolver = (records: Record<string, { a?: string[]; cname?: string[] }>): DnsResolver => ({
    resolve4: async (h) => records[h]?.a ?? [],
    resolve6: async () => [],
    resolveCname: async (h) => records[h]?.cname ?? [],
  });

  it("resolves both hosts and verifies via the injected resolver", async () => {
    const result = await verifyDomainPointsToApp(
      "site.example.org",
      resolver({
        "app.example.org": { a: ["9.9.9.9"] },
        "site.example.org": { a: ["9.9.9.9"] },
      }),
      "app.example.org",
    );
    expect(result.verified).toBe(true);
  });

  it("throws DomainVerifyError with no app host configured", async () => {
    const saved = {
      base: process.env.NEXT_PUBLIC_BASE_URL,
      base2: process.env.BASE_URL,
      nextauth: process.env.NEXTAUTH_URL,
    };
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.BASE_URL;
    delete process.env.NEXTAUTH_URL;
    try {
      await expect(
        verifyDomainPointsToApp("site.example.org", resolver({})),
      ).rejects.toBeInstanceOf(DomainVerifyError);
    } finally {
      if (saved.base) process.env.NEXT_PUBLIC_BASE_URL = saved.base;
      if (saved.base2) process.env.BASE_URL = saved.base2;
      if (saved.nextauth) process.env.NEXTAUTH_URL = saved.nextauth;
    }
  });
});

// ---------------------------------------------------------------------------
// Shared serve helpers
// ---------------------------------------------------------------------------

describe("resolveSitePath", () => {
  it("defaults empty and trailing-slash paths to index.html", () => {
    expect(resolveSitePath(undefined)).toBe("index.html");
    expect(resolveSitePath([])).toBe("index.html");
    expect(resolveSitePath(["docs", ""])).toBe("docs/index.html");
  });

  it("passes named files through and rejects traversal", () => {
    expect(resolveSitePath(["style.css"])).toBe("style.css");
    expect(resolveSitePath(["..", "secret"])).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("style.css")).toContain("text/css");
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});

describe("withSiteBase", () => {
  it("injects a base tag after <head> and normalizes the trailing slash", () => {
    const html = "<html><head><title>x</title></head><body></body></html>";
    expect(withSiteBase(html, "/groups/g1/site")).toContain(
      '<head><base href="/groups/g1/site/" />',
    );
    expect(withSiteBase(html, "/")).toContain('<base href="/" />');
  });

  it("leaves documents with their own base untouched and handles headless fragments", () => {
    const withBase = '<html><head><base href="/x/" /></head></html>';
    expect(withSiteBase(withBase, "/y")).toBe(withBase);
    expect(withSiteBase("<p>hi</p>", "/y")).toBe('<base href="/y/" /><p>hi</p>');
  });
});
