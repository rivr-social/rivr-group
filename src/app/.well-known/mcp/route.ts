import { NextResponse } from "next/server";
import { getMcpServerMetadata } from "@/lib/federation/mcp-server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getMcpServerMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
