import { NextResponse } from "next/server";
import { buildAppReleaseStatus } from "@/lib/app-release";

export async function GET() {
  const status = await buildAppReleaseStatus({
    appName: "rivr-group",
    defaultVersion: "0.1.0",
    defaultUpstreamRepo: "rivr-social/rivr-group",
  });

  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "s-maxage=300, stale-while-revalidate=300",
    },
  });
}
