import { describe, expect, it } from "vitest";
import {
  SOCIAL_PLATFORMS,
  MAX_SOCIAL_LINKS,
  isSupportedSocialPlatform,
  getSocialPlatform,
  normalizeSocialLinkValue,
  validateSocialLinks,
  mergeSocialLinksIntoMetadata,
  readSocialLinksFromMetadata,
} from "../social-links";

describe("social-links: platform registry", () => {
  it("exposes a non-empty, lowercase-keyed platform list", () => {
    expect(SOCIAL_PLATFORMS.length).toBeGreaterThan(0);
    for (const platform of SOCIAL_PLATFORMS) {
      expect(platform.key).toBe(platform.key.toLowerCase());
    }
  });

  it("recognizes supported platforms case-insensitively", () => {
    expect(isSupportedSocialPlatform("instagram")).toBe(true);
    expect(isSupportedSocialPlatform("INSTAGRAM")).toBe(true);
    expect(isSupportedSocialPlatform("myspace")).toBe(false);
  });

  it("returns descriptors for known keys and undefined for unknown", () => {
    expect(getSocialPlatform("website")?.kind).toBe("url");
    expect(getSocialPlatform("phone")?.kind).toBe("tel");
    expect(getSocialPlatform("email")?.kind).toBe("email");
    expect(getSocialPlatform("nope")).toBeUndefined();
  });
});

describe("social-links: normalizeSocialLinkValue — URL platforms", () => {
  it("prepends https:// when scheme is missing for website", () => {
    const result = normalizeSocialLinkValue("website", "example.com");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("https://example.com/");
  });

  it("preserves existing https scheme", () => {
    const result = normalizeSocialLinkValue("website", "https://example.com/path");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("https://example.com/path");
  });

  it("rejects non-http(s) protocols (javascript: injection)", () => {
    const result = normalizeSocialLinkValue("website", "javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("enforces platform host allowlist for instagram", () => {
    const ok = normalizeSocialLinkValue("instagram", "https://instagram.com/rivr");
    expect(ok.ok).toBe(true);
    const subdomain = normalizeSocialLinkValue("instagram", "https://www.instagram.com/rivr");
    expect(subdomain.ok).toBe(true);
    const bad = normalizeSocialLinkValue("instagram", "https://evil.example/rivr");
    expect(bad.ok).toBe(false);
  });

  it("accepts t.me and telegram hosts for telegram", () => {
    expect(normalizeSocialLinkValue("telegram", "https://t.me/rivr").ok).toBe(true);
    expect(normalizeSocialLinkValue("telegram", "t.me/rivr").ok).toBe(true);
    expect(normalizeSocialLinkValue("telegram", "https://example.com/rivr").ok).toBe(false);
  });

  it("accepts x.com and twitter.com for x", () => {
    expect(normalizeSocialLinkValue("x", "https://x.com/rivr").ok).toBe(true);
    expect(normalizeSocialLinkValue("x", "https://twitter.com/rivr").ok).toBe(true);
  });

  it("rejects a malformed URL", () => {
    // A bare scheme with no host cannot be parsed into a valid URL.
    const result = normalizeSocialLinkValue("website", "https://");
    expect(result.ok).toBe(false);
  });
});

describe("social-links: normalizeSocialLinkValue — phone & email", () => {
  it("strips invalid phone characters and keeps format chars", () => {
    const result = normalizeSocialLinkValue("phone", " (555) 123-4567 ext " );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("(555) 123-4567");
  });

  it("rejects a phone with too few digits", () => {
    expect(normalizeSocialLinkValue("phone", "12").ok).toBe(false);
  });

  it("lowercases and validates email shape", () => {
    const result = normalizeSocialLinkValue("email", "Hello@Example.COM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello@example.com");
  });

  it("rejects an invalid email", () => {
    expect(normalizeSocialLinkValue("email", "not-an-email").ok).toBe(false);
  });
});

describe("social-links: normalizeSocialLinkValue — error paths", () => {
  it("rejects unsupported platforms", () => {
    const result = normalizeSocialLinkValue("myspace", "https://myspace.com/x");
    expect(result.ok).toBe(false);
  });

  it("rejects empty/whitespace values", () => {
    expect(normalizeSocialLinkValue("website", "   ").ok).toBe(false);
    expect(normalizeSocialLinkValue("website", "").ok).toBe(false);
  });
});

describe("social-links: validateSocialLinks", () => {
  it("normalizes valid entries and drops blanks without error", () => {
    const { socialLinks, errors } = validateSocialLinks({
      website: "rivr.social",
      instagram: "",
      x: "https://x.com/rivr",
    });
    expect(errors).toHaveLength(0);
    expect(socialLinks.website).toBe("https://rivr.social/");
    expect(socialLinks.x).toBe("https://x.com/rivr");
    expect(socialLinks.instagram).toBeUndefined();
  });

  it("collects errors for invalid entries and drops them", () => {
    const { socialLinks, errors } = validateSocialLinks({
      website: "https://ok.example",
      instagram: "https://evil.example",
    });
    expect(socialLinks.website).toBe("https://ok.example/");
    expect(socialLinks.instagram).toBeUndefined();
    expect(errors.some((e) => e.platform === "instagram")).toBe(true);
  });

  it("rejects unknown platforms with an error", () => {
    const { socialLinks, errors } = validateSocialLinks({ myspace: "https://m.example" });
    expect(Object.keys(socialLinks)).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].platform).toBe("myspace");
  });

  it("lowercases platform keys", () => {
    const { socialLinks } = validateSocialLinks({ WEBSITE: "example.com" });
    expect(socialLinks.website).toBe("https://example.com/");
  });

  it("returns empty result for null/undefined/non-object input", () => {
    expect(validateSocialLinks(null).socialLinks).toEqual({});
    expect(validateSocialLinks(undefined).socialLinks).toEqual({});
    expect(validateSocialLinks(("string" as unknown) as Record<string, unknown>).socialLinks).toEqual({});
  });

  it("caps the number of stored links at MAX_SOCIAL_LINKS", () => {
    const oversized: Record<string, string> = {};
    for (let i = 0; i < MAX_SOCIAL_LINKS + 3; i++) {
      oversized[`unknown${i}`] = "https://example.com";
    }
    const { socialLinks } = validateSocialLinks(oversized);
    expect(Object.keys(socialLinks).length).toBeLessThanOrEqual(MAX_SOCIAL_LINKS);
  });
});

describe("social-links: metadata merge & read", () => {
  it("merges social links while preserving unrelated metadata keys", () => {
    const merged = mergeSocialLinksIntoMetadata(
      { bio: "hi", socialLinks: { website: "old" } },
      { x: "https://x.com/rivr" }
    );
    expect(merged.bio).toBe("hi");
    expect(merged.socialLinks).toEqual({ x: "https://x.com/rivr" });
  });

  it("does not mutate the input metadata object", () => {
    const original = { bio: "hi" };
    mergeSocialLinksIntoMetadata(original, { website: "https://ok.example/" });
    expect(original).toEqual({ bio: "hi" });
  });

  it("handles null/undefined existing metadata", () => {
    expect(mergeSocialLinksIntoMetadata(null, { website: "x" })).toEqual({ socialLinks: { website: "x" } });
    expect(mergeSocialLinksIntoMetadata(undefined, {})).toEqual({ socialLinks: {} });
  });

  it("reads social links from canonical and snake_case keys", () => {
    expect(readSocialLinksFromMetadata({ socialLinks: { website: "a" } })).toEqual({ website: "a" });
    expect(readSocialLinksFromMetadata({ social_links: { Website: "a" } })).toEqual({ website: "a" });
    expect(readSocialLinksFromMetadata({})).toEqual({});
    expect(readSocialLinksFromMetadata(null)).toEqual({});
  });

  it("drops non-string values when reading", () => {
    const read = readSocialLinksFromMetadata({ socialLinks: { website: "a", x: 5 as unknown as string } });
    expect(read).toEqual({ website: "a" });
  });
});
