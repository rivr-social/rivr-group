/**
 * Tests for `src/lib/federation/entity-link.ts`.
 *
 * Covers the pure, client-safe canonical link resolver that routes an
 * entity/federated-projection to the correct href:
 *
 *   - resolveRemoteHomeBaseUrl: the home-stamp precedence ladder
 *       (homeBaseUrl → federatedHomeBaseUrl → origin of canonicalUrl),
 *       trailing-slash normalization, empty/whitespace skipping, and malformed
 *       canonicalUrl tolerance.
 *   - resolveEntityHref: remote → absolute home URL (isRemote), local vs
 *       globalFallback routing, path leading-slash normalization, clean base+path
 *       composition, and the self-host loop guard (a stamp pointing back at our
 *       own host is treated as local).
 *
 * `./global-url` is mocked so `globalFallback` assertions are deterministic and
 * independent of REGISTRY_URL / NEXT_PUBLIC_* env resolution.
 */

import { describe, expect, it, vi } from "vitest";

// Deterministic global aggregator base: getGlobalUrl(path) → `https://global.test` + path.
vi.mock("@/lib/federation/global-url", () => ({
  getGlobalUrl: (path: string) => `https://global.test${path}`,
}));

import { resolveEntityHref, resolveRemoteHomeBaseUrl } from "../entity-link";

const SELF = "https://cameron.rivr.social";
const SPIRIT = "https://spirit.rivr.social";

describe("resolveRemoteHomeBaseUrl", () => {
  it("returns null for null / non-object metadata", () => {
    expect(resolveRemoteHomeBaseUrl(null)).toBeNull();
    expect(resolveRemoteHomeBaseUrl(undefined)).toBeNull();
    expect(resolveRemoteHomeBaseUrl("nope")).toBeNull();
    expect(resolveRemoteHomeBaseUrl(42)).toBeNull();
  });

  it("returns null when no home stamp is present (locally-homed / unknown)", () => {
    expect(resolveRemoteHomeBaseUrl({})).toBeNull();
    expect(resolveRemoteHomeBaseUrl({ name: "Spirit", memberCount: 3 })).toBeNull();
  });

  it("rung 1: reads homeBaseUrl", () => {
    expect(resolveRemoteHomeBaseUrl({ homeBaseUrl: SPIRIT })).toBe(SPIRIT);
  });

  it("rung 2: falls back to federatedHomeBaseUrl when homeBaseUrl is absent", () => {
    expect(resolveRemoteHomeBaseUrl({ federatedHomeBaseUrl: SPIRIT })).toBe(SPIRIT);
  });

  it("rung 3: derives the origin from canonicalUrl when the direct stamps are absent", () => {
    expect(
      resolveRemoteHomeBaseUrl({ canonicalUrl: `${SPIRIT}/groups/abc?tab=jobs#top` }),
    ).toBe(SPIRIT);
  });

  it("honors the precedence order (homeBaseUrl wins over the lower rungs)", () => {
    expect(
      resolveRemoteHomeBaseUrl({
        homeBaseUrl: SPIRIT,
        federatedHomeBaseUrl: "https://other.rivr.social",
        canonicalUrl: "https://third.rivr.social/groups/abc",
      }),
    ).toBe(SPIRIT);
  });

  it("federatedHomeBaseUrl wins over canonicalUrl when homeBaseUrl is absent", () => {
    expect(
      resolveRemoteHomeBaseUrl({
        federatedHomeBaseUrl: SPIRIT,
        canonicalUrl: "https://third.rivr.social/groups/abc",
      }),
    ).toBe(SPIRIT);
  });

  it("strips trailing slashes so bases compose consistently", () => {
    expect(resolveRemoteHomeBaseUrl({ homeBaseUrl: `${SPIRIT}///` })).toBe(SPIRIT);
  });

  it("skips empty / whitespace-only stamps and falls through", () => {
    expect(
      resolveRemoteHomeBaseUrl({ homeBaseUrl: "   ", federatedHomeBaseUrl: SPIRIT }),
    ).toBe(SPIRIT);
    expect(resolveRemoteHomeBaseUrl({ homeBaseUrl: "", federatedHomeBaseUrl: "" })).toBeNull();
  });

  it("returns null for a malformed canonicalUrl (never throws)", () => {
    expect(resolveRemoteHomeBaseUrl({ canonicalUrl: "not a url" })).toBeNull();
    expect(resolveRemoteHomeBaseUrl({ canonicalUrl: "/relative/path" })).toBeNull();
  });
});

describe("resolveEntityHref", () => {
  it("remote-homed entity → absolute URL on its home instance, isRemote true", () => {
    const result = resolveEntityHref({ homeBaseUrl: SPIRIT }, "/groups/abc");
    expect(result).toEqual({ href: `${SPIRIT}/groups/abc`, isRemote: true });
  });

  it("normalizes a localPath that is missing its leading slash", () => {
    const result = resolveEntityHref({ homeBaseUrl: SPIRIT }, "groups/abc");
    expect(result.href).toBe(`${SPIRIT}/groups/abc`);
  });

  it("composes base + path cleanly when the home stamp has a trailing slash", () => {
    const result = resolveEntityHref({ homeBaseUrl: `${SPIRIT}/` }, "/groups/abc");
    expect(result.href).toBe(`${SPIRIT}/groups/abc`);
  });

  it("local + globalFallback:false → verbatim local path, isRemote false", () => {
    const result = resolveEntityHref({}, "/profile/cameron", { globalFallback: false });
    expect(result).toEqual({ href: "/profile/cameron", isRemote: false });
  });

  it("local + globalFallback:true → global aggregator URL, isRemote true", () => {
    const result = resolveEntityHref({}, "/groups/abc", { globalFallback: true });
    expect(result).toEqual({ href: "https://global.test/groups/abc", isRemote: true });
  });

  it("loop guard: a stamp pointing at our own host is treated as local (globalFallback:false)", () => {
    const result = resolveEntityHref(
      { homeBaseUrl: `${SELF}` },
      "/profile/cameron",
      { selfBaseUrl: SELF, globalFallback: false },
    );
    expect(result).toEqual({ href: "/profile/cameron", isRemote: false });
  });

  it("loop guard: a self-host group stamp with globalFallback:true routes to global, not back to us", () => {
    const result = resolveEntityHref(
      { homeBaseUrl: SELF },
      "/groups/abc",
      { selfBaseUrl: SELF, globalFallback: true },
    );
    expect(result).toEqual({ href: "https://global.test/groups/abc", isRemote: true });
  });

  it("loop guard compares host only (differing scheme / path on selfBaseUrl still matches)", () => {
    const result = resolveEntityHref(
      { homeBaseUrl: SELF },
      "/profile/cameron",
      { selfBaseUrl: `${SELF}/some/path`, globalFallback: false },
    );
    expect(result.isRemote).toBe(false);
  });

  it("a stamp on a DIFFERENT host is respected even when selfBaseUrl is provided", () => {
    const result = resolveEntityHref(
      { homeBaseUrl: SPIRIT },
      "/groups/abc",
      { selfBaseUrl: SELF, globalFallback: true },
    );
    expect(result).toEqual({ href: `${SPIRIT}/groups/abc`, isRemote: true });
  });

  it("malformed canonicalUrl with globalFallback:true falls through to the global URL", () => {
    const result = resolveEntityHref(
      { canonicalUrl: "not a url" },
      "/groups/abc",
      { globalFallback: true },
    );
    expect(result).toEqual({ href: "https://global.test/groups/abc", isRemote: true });
  });

  it("resolves via canonicalUrl origin when only that stamp is present", () => {
    const result = resolveEntityHref(
      { canonicalUrl: `${SPIRIT}/groups/abc` },
      "/groups/abc",
      { globalFallback: true },
    );
    expect(result).toEqual({ href: `${SPIRIT}/groups/abc`, isRemote: true });
  });

  it("defaults (no options) treat an unstamped entity as a verbatim local path", () => {
    expect(resolveEntityHref({}, "/profile/cameron")).toEqual({
      href: "/profile/cameron",
      isRemote: false,
    });
  });
});
