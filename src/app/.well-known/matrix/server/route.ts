import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function GET() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN || "localhost";

  return NextResponse.json(
    { "m.server": `matrix.${domain}:443` },
    { headers: CORS_HEADERS }
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
