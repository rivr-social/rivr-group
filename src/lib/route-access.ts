const PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/auth/login",
  "/explore",
  "/map",
  "/search",
  "/calendar",
  "/manifest.webmanifest",
  "/llms.html",
  "/llms.txt",
]);

const PUBLIC_PAGE_PREFIXES = [
  // /docs subtree is auth-optional so agents and anonymous visitors can read it.
  "/docs",
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

const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/billing/trial-reminders",
  "/api/cron/federation-deliver",
  "/api/cron/federation-sync",
  "/api/cron/google-calendar-sync",
  "/api/health",
  "/api/federation",
  "/api/murmurations",
  "/api/universal-manifest",
  "/api/stripe/webhook",
  // LiveKit webhook: machine lane, authenticated inside the route by the
  // LiveKit-signed JWT (Virtual Meeting recording pipeline) — same model
  // as the Stripe webhook above.
  "/api/livekit/webhook",
  "/api/stripe/checkout",
  "/api/stripe/marketplace-checkout",
  "/api/stripe/payment-intent",
  "/api/map-style-tiles",
  "/api/map-style",
  "/api/map-tilesets",
  "/api/map-diagnostics",
  "/api/locations/suggest",
  "/.well-known/matrix",
  "/.well-known/openid-configuration",
  "/.well-known/universal-manifest.json",
  "/.well-known/mcp",
  "/api/mcp",
];

export function isPublicPageRoute(pathname: string): boolean {
  if (PUBLIC_PAGE_PATHS.has(pathname)) {
    return true;
  }

  return PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isPublicRoute(pathname: string): boolean {
  if (isPublicPageRoute(pathname)) {
    return true;
  }

  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export {
  PUBLIC_API_PREFIXES,
  PUBLIC_PAGE_PATHS,
  PUBLIC_PAGE_PREFIXES,
};
