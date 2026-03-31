import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function GET() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN || "localhost";

  return NextResponse.json(
    {
      "m.homeserver": {
        base_url: `https://matrix.${domain}`,
      },
      "m.identity_server": {
        base_url: `https://matrix.${domain}`,
      },
    },
    { headers: CORS_HEADERS }
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
