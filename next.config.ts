import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDomain = process.env.NEXT_PUBLIC_DOMAIN;
const publicAssetBaseUrl = process.env.ASSET_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_MINIO_URL?.trim();

const extraImageDomains = (process.env.NEXT_PUBLIC_IMAGE_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter((domain) => domain.length > 0);

function toRemotePattern(urlValue: string) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      protocol: parsed.protocol.replace(":", "") as "http" | "https",
      hostname: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
      pathname: "/**",
    };
  } catch {
    return null;
  }
}

const publicAssetPattern = publicAssetBaseUrl ? toRemotePattern(publicAssetBaseUrl) : null;
const staticRemotePatterns = [
  {
    protocol: "https" as const,
    hostname: "s3.rivr.social",
    pathname: "/**",
  },
  {
    protocol: "https" as const,
    hostname: "matrix.rivr.social",
    pathname: "/**",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Client-side router cache (Wave A, perf #69/#92). Previously {0,0} which
    // forced every back/forward/tab-switch to re-fetch the RSC payload from the
    // server — the "every click hits the network" sluggishness. Restored to
    // dynamic 30s / static 180s: visited routes are reused from the in-memory
    // client cache for that window. This is a per-browser cache (no CDN/shared
    // state → no cross-user session leak); mutations still invalidate via the
    // existing revalidatePath/revalidateTag calls.
    staleTimes: { dynamic: 30, static: 180 },
    // Barrel-import optimization: rewrite named imports from these large
    // packages to direct deep imports so unused exports are tree-shaken out of
    // the shared chunk.
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["@rivr/db", "@rivr/federation", "@rivr/lib", "@rivr/ui"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  images: {
    dangerouslyAllowSVG: true,
    remotePatterns: [
      ...staticRemotePatterns,
      {
        protocol: "http",
        hostname: "localhost",
        port: "9000",
        pathname: "/**",
      },
      {
        protocol: "http",
        hostname: "minio",
        port: "9000",
        pathname: "/**",
      },
      // Production MinIO (s3.DOMAIN)
      ...(publicDomain
        ? [{ protocol: "https" as const, hostname: `s3.${publicDomain}`, pathname: "/**" }]
        : []),
      // Matrix avatar URLs (matrix.DOMAIN)
      ...(publicDomain
        ? [{ protocol: "https" as const, hostname: `matrix.${publicDomain}`, pathname: "/**" }]
        : []),
      ...(publicAssetPattern ? [publicAssetPattern] : []),
      ...extraImageDomains.map((hostname) => ({
        protocol: "https" as const,
        hostname,
        pathname: "/**",
      })),
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // CSP is set per-request in middleware.ts with a unique nonce
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
