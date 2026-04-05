import { NextResponse } from "next/server";
import { handleMcpRequest, getMcpServerMetadata } from "@/lib/federation/mcp-server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getMcpServerMetadata(), {
    headers: noStoreHeaders(),
  });
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      },
      {
        status: 400,
        headers: noStoreHeaders(),
      },
    );
  }

  const result = await handleMcpRequest(
    request,
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  );

  const hasError = result && typeof result === "object" && "error" in result;

  return NextResponse.json(result, {
    status: hasError ? 400 : 200,
    headers: noStoreHeaders(),
  });
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  };
}
