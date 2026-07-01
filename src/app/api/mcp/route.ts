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

  const rpc =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  // JSON-RPC notifications (a request with no `id`, e.g. the
  // `notifications/initialized` an MCP Streamable-HTTP client sends right after
  // `initialize`) carry no response. The spec requires the server to ack them
  // with `202 Accepted` and an empty body. Routing them through the request
  // handler would return a "Method not found" error, which this route maps to
  // HTTP 400 — breaking the client handshake before any tool can be called.
  const method = typeof rpc.method === "string" ? rpc.method : "";
  const isNotification = !("id" in rpc) && method.startsWith("notifications/");
  if (isNotification) {
    return new NextResponse(null, { status: 202, headers: noStoreHeaders() });
  }

  const result = await handleMcpRequest(request, rpc);

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
