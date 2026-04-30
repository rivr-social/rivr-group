import { NextResponse } from "next/server";

import { getGlobalIdentityAuthorityUrl } from "@/lib/federation/instance-config";

function resolveGlobalRegistryUrl(request: Request): URL {
  const base =
    getGlobalIdentityAuthorityUrl() ||
    process.env.NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL ||
    "https://a.rivr.social";

  const url = new URL("/api/federation/registry", base);
  const incoming = new URL(request.url);
  const kind = incoming.searchParams.get("kind");
  if (kind) {
    url.searchParams.set("kind", kind);
  }
  return url;
}

export async function GET(request: Request) {
  try {
    const upstream = await fetch(resolveGlobalRegistryUrl(request), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[federation/global-registry] proxy failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load global registry" },
      { status: 502 },
    );
  }
}
