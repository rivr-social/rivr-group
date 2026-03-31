import { describe, expect, it } from "vitest";

import {
  isPublicPageRoute,
  isPublicRoute,
  PUBLIC_API_PREFIXES,
  PUBLIC_PAGE_PATHS,
  PUBLIC_PAGE_PREFIXES,
} from "@/lib/route-access";

describe("route-access", () => {
  // ─── Exact public page paths ───────────────────────────────────────

  describe("exact public page paths", () => {
    const EXACT_PATHS = [
      "/",
      "/auth/login",
      "/explore",
      "/map",
      "/search",
      "/calendar",
      "/manifest.webmanifest",
    ];

    it.each(EXACT_PATHS)("marks %s as public page route", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });

    it.each(EXACT_PATHS)("marks %s as public route", (path) => {
      expect(isPublicRoute(path)).toBe(true);
    });

    it("exact paths list matches exported PUBLIC_PAGE_PATHS", () => {
      expect(EXACT_PATHS.length).toBe(PUBLIC_PAGE_PATHS.size);
      for (const p of EXACT_PATHS) {
        expect(PUBLIC_PAGE_PATHS.has(p)).toBe(true);
      }
    });
  });

  // ─── Prefix-based public page routes ───────────────────────────────

  describe("prefix-based public page routes", () => {
    it.each([
      ["/events", "bare prefix"],
      ["/events/123", "numeric subpath"],
      ["/events/abc-def", "slug subpath"],
      ["/events/123/details", "nested subpath"],
    ])("marks %s as public (%s)", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });

    it.each([
      ["/groups", "bare prefix"],
      ["/groups/abc", "slug subpath"],
      ["/groups/abc/settings", "nested subpath"],
      ["/groups/abc/members/456", "deeply nested"],
    ])("marks %s as public (%s)", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });

    it.each([
      ["/marketplace", "bare prefix"],
      ["/marketplace/550e8400-e29b-41d4-a716-446655440000", "UUID subpath"],
      ["/marketplace/offering-slug", "slug subpath"],
    ])("marks %s as public (%s)", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });

    it.each([
      ["/locales", "bare prefix"],
      ["/locales/downtown", "slug subpath"],
      ["/basins", "bare prefix"],
      ["/basins/river-valley", "slug subpath"],
      ["/rings", "bare prefix"],
      ["/rings/inner-ring", "slug subpath"],
      ["/families", "bare prefix"],
      ["/families/test-family", "slug subpath"],
      ["/families/test-family/members", "nested subpath"],
      ["/people", "bare prefix"],
      ["/people/jane-doe", "slug subpath"],
      ["/badges", "bare prefix"],
      ["/badges/community-hero", "slug subpath"],
      ["/posts", "bare prefix"],
      ["/posts/post-123", "slug subpath"],
      ["/projects", "bare prefix"],
      ["/projects/my-project", "slug subpath"],
      ["/jobs", "bare prefix"],
      ["/jobs/senior-dev", "slug subpath"],
      ["/products", "bare prefix"],
      ["/products/widget-x", "slug subpath"],
    ])("marks %s as public (%s)", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });

    it("prefix list matches exported PUBLIC_PAGE_PREFIXES", () => {
      const EXPECTED_PREFIXES = [
        "/auth/signup",
        "/auth/reset-password",
        "/auth/forgot-password",
        "/events",
        "/marketplace",
        "/groups",
        "/locales",
        "/basins",
        "/rings",
        "/families",
        "/people",
        "/badges",
        "/posts",
        "/profile/",
        "/projects",
        "/jobs",
        "/products",
      ];
      expect(PUBLIC_PAGE_PREFIXES).toEqual(EXPECTED_PREFIXES);
    });
  });

  // ─── Auth prefix routes ────────────────────────────────────────────

  describe("auth prefix routes", () => {
    it.each([
      "/auth/signup",
      "/auth/signup?ref=home",
      "/auth/reset-password",
      "/auth/reset-password/token-abc",
      "/auth/forgot-password",
      "/auth/forgot-password/confirm",
    ])("marks %s as public", (path) => {
      expect(isPublicPageRoute(path)).toBe(true);
    });
  });

  // ─── Dynamic route segments ────────────────────────────────────────

  describe("dynamic route segments", () => {
    it("handles /profile/ with username", () => {
      expect(isPublicPageRoute("/profile/username")).toBe(true);
      expect(isPublicPageRoute("/profile/jane-doe")).toBe(true);
      expect(isPublicPageRoute("/profile/user_123")).toBe(true);
    });

    it("rejects /profile without trailing slash (not in prefix or exact set)", () => {
      // "/profile/" is the prefix, so "/profile" does NOT start with "/profile/"
      // and "/profile" is NOT in the exact set
      expect(isPublicPageRoute("/profile")).toBe(false);
    });

    it("handles marketplace with UUID-like segments", () => {
      expect(
        isPublicPageRoute(
          "/marketplace/550e8400-e29b-41d4-a716-446655440000"
        )
      ).toBe(true);
    });

    it("handles events with numeric IDs", () => {
      expect(isPublicPageRoute("/events/99999")).toBe(true);
    });
  });

  // ─── Trailing slash handling ───────────────────────────────────────

  describe("trailing slash handling", () => {
    it("exact paths do NOT match with trailing slash", () => {
      // The Set uses exact match, so "/explore/" !== "/explore"
      expect(isPublicPageRoute("/explore/")).toBe(false);
      expect(isPublicPageRoute("/map/")).toBe(false);
      expect(isPublicPageRoute("/search/")).toBe(false);
      expect(isPublicPageRoute("/calendar/")).toBe(false);
    });

    it("prefix paths match with trailing slash", () => {
      expect(isPublicPageRoute("/events/")).toBe(true);
      expect(isPublicPageRoute("/groups/")).toBe(true);
      expect(isPublicPageRoute("/families/")).toBe(true);
    });

    it("root with trailing content is not exact match but may match prefix", () => {
      // "/" is exact, "/something" would need to match a prefix
      expect(isPublicPageRoute("/")).toBe(true);
    });
  });

  // ─── Protected routes ──────────────────────────────────────────────

  describe("protected routes that MUST NOT be public", () => {
    const PROTECTED_PATHS = [
      "/admin",
      "/admin/users",
      "/admin/settings",
      "/create",
      "/create/event",
      "/create/post",
      "/messages",
      "/messages/inbox",
      "/messages/thread/123",
      "/notifications",
      "/notifications/settings",
      "/wallet",
      "/wallet/transactions",
      "/settings",
      "/settings/account",
      "/dashboard",
      "/profile",
    ];

    it.each(PROTECTED_PATHS)(
      "marks %s as NOT a public page route",
      (path) => {
        expect(isPublicPageRoute(path)).toBe(false);
      }
    );

    it.each(PROTECTED_PATHS)("marks %s as NOT a public route", (path) => {
      expect(isPublicRoute(path)).toBe(false);
    });
  });

  // ─── Public API prefixes ───────────────────────────────────────────

  describe("public API routes", () => {
    it.each([
      ["/api/auth", "auth base"],
      ["/api/auth/login", "auth login"],
      ["/api/auth/verify-email", "auth verify-email"],
      ["/api/auth/verify-email?token=abc", "auth with query"],
      ["/api/billing/trial-reminders", "billing trial reminders"],
      ["/api/health", "health check"],
      ["/api/health/deep", "health deep"],
      ["/api/federation", "federation base"],
      ["/api/federation/webfinger", "federation subpath"],
      ["/api/murmurations", "murmurations base"],
      ["/api/murmurations/profiles", "murmurations subpath"],
      ["/api/universal-manifest", "universal-manifest"],
      ["/api/stripe/webhook", "stripe webhook"],
      ["/api/stripe/checkout", "stripe checkout"],
      ["/api/stripe/checkout/session-123", "stripe checkout subpath"],
      ["/api/stripe/marketplace-checkout", "stripe marketplace checkout"],
      ["/api/stripe/payment-intent", "stripe payment intent"],
      ["/api/stripe/payment-intent/pi_123", "stripe payment intent subpath"],
      ["/api/map-style-tiles", "map style tiles"],
      ["/api/map-style-tiles/terrain/256", "map tiles subpath"],
      ["/api/map-style", "map style"],
      ["/api/map-tilesets", "map tilesets"],
      ["/api/map-diagnostics", "map diagnostics"],
      ["/api/locations/suggest", "locations suggest"],
      ["/api/locations/suggest?q=park", "locations suggest with query"],
      ["/.well-known/matrix", "well-known matrix"],
      ["/.well-known/matrix/client", "well-known matrix client"],
      ["/.well-known/matrix/server", "well-known matrix server"],
      [
        "/.well-known/universal-manifest.json",
        "well-known universal manifest",
      ],
    ])("marks %s as public route (%s)", (path) => {
      expect(isPublicRoute(path)).toBe(true);
    });

    it("public API routes are NOT public page routes", () => {
      expect(isPublicPageRoute("/api/health")).toBe(false);
      expect(isPublicPageRoute("/api/auth/login")).toBe(false);
      expect(isPublicPageRoute("/.well-known/matrix/client")).toBe(false);
    });

    it("API prefix list matches exported PUBLIC_API_PREFIXES", () => {
      const EXPECTED_API_PREFIXES = [
        "/api/auth",
        "/api/billing/trial-reminders",
        "/api/health",
        "/api/federation",
        "/api/murmurations",
        "/api/universal-manifest",
        "/api/stripe/webhook",
        "/api/stripe/checkout",
        "/api/stripe/marketplace-checkout",
        "/api/stripe/payment-intent",
        "/api/map-style-tiles",
        "/api/map-style",
        "/api/map-tilesets",
        "/api/map-diagnostics",
        "/api/locations/suggest",
        "/.well-known/matrix",
        "/.well-known/universal-manifest.json",
      ];
      expect(PUBLIC_API_PREFIXES).toEqual(EXPECTED_API_PREFIXES);
    });
  });

  // ─── Protected API routes ──────────────────────────────────────────

  describe("protected API routes", () => {
    const PROTECTED_API_PATHS = [
      "/api/users",
      "/api/resources",
      "/api/admin",
      "/api/wallet",
      "/api/messages",
      "/api/notifications",
      "/api/stripe/connect",
      "/api/billing/subscription",
    ];

    it.each(PROTECTED_API_PATHS)(
      "marks %s as NOT a public route",
      (path) => {
        expect(isPublicRoute(path)).toBe(false);
      }
    );
  });

  // ─── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(isPublicPageRoute("")).toBe(false);
      expect(isPublicRoute("")).toBe(false);
    });

    it("handles just /", () => {
      expect(isPublicPageRoute("/")).toBe(true);
      expect(isPublicRoute("/")).toBe(true);
    });

    it("paths with query-string-like suffixes still match via startsWith", () => {
      // startsWith would match these since query strings are part of the string
      expect(isPublicRoute("/api/health?check=deep")).toBe(true);
      expect(isPublicPageRoute("/events?page=2")).toBe(true);
    });

    it("similar-but-different paths are not accidentally public", () => {
      // "/exploring" should not match "/explore" (exact match only)
      expect(isPublicPageRoute("/exploring")).toBe(false);
      // "/maps" should not match "/map"
      expect(isPublicPageRoute("/maps")).toBe(false);
      // "/searching" should not match "/search"
      expect(isPublicPageRoute("/searching")).toBe(false);
      // "/calendars" should not match "/calendar"
      expect(isPublicPageRoute("/calendars")).toBe(false);
    });

    it("case sensitivity: paths are case-sensitive", () => {
      expect(isPublicPageRoute("/Explore")).toBe(false);
      expect(isPublicPageRoute("/EXPLORE")).toBe(false);
      expect(isPublicRoute("/API/HEALTH")).toBe(false);
    });

    it("double slashes are not matched", () => {
      expect(isPublicPageRoute("//explore")).toBe(false);
      expect(isPublicRoute("//api/health")).toBe(false);
    });
  });

  // ─── /families specifically ────────────────────────────────────────

  describe("/families is public", () => {
    it("bare /families is public", () => {
      expect(isPublicPageRoute("/families")).toBe(true);
      expect(isPublicRoute("/families")).toBe(true);
    });

    it("/families with subpath is public", () => {
      expect(isPublicPageRoute("/families/doe-family")).toBe(true);
      expect(isPublicPageRoute("/families/doe-family/members")).toBe(true);
    });
  });

  // ─── isPublicRoute encompasses isPublicPageRoute ───────────────────

  describe("isPublicRoute is a superset of isPublicPageRoute", () => {
    it("every public page route is also a public route", () => {
      const allPagePaths = [...PUBLIC_PAGE_PATHS];
      for (const p of allPagePaths) {
        expect(isPublicRoute(p)).toBe(true);
      }
    });

    it("prefix page routes are also public routes", () => {
      for (const prefix of PUBLIC_PAGE_PREFIXES) {
        expect(isPublicRoute(prefix)).toBe(true);
        expect(isPublicRoute(`${prefix}/subpath`)).toBe(true);
      }
    });
  });
});
