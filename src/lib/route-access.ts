const PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/auth/login",
  "/explore",
  "/map",
  "/search",
  "/calendar",
  "/manifest.webmanifest",
]);

const PUBLIC_PAGE_PREFIXES = [
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
