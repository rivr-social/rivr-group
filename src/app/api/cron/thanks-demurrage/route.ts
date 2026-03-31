import { readFileSync } from "node:fs";

import { NextResponse } from "next/server";

import { processAllThanksTokenDemurrage } from "@/lib/thanks-demurrage";

function isAuthorized(request: Request): boolean {
  const configuredKey = getConfiguredAdminKey();
  if (!configuredKey) return false;

  const authHeader = request.headers.get("authorization");
  const headerKey = request.headers.get("x-node-admin-key");
  const bearerKey =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice("bearer ".length).trim()
      : null;

  return headerKey === configuredKey || bearerKey === configuredKey;
}

function getConfiguredAdminKey(): string | null {
  const envKey = process.env.NODE_ADMIN_KEY?.trim();
  if (envKey) return envKey;

  try {
    const secretKey = readFileSync("/run/secrets/rivr_federation_admin_key", "utf8").trim();
    return secretKey || null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results = await processAllThanksTokenDemurrage(new Date());
    const aggregate = results.reduce(
      (acc, entry) => {
        acc.accounts += 1;
        acc.tokens += entry.tokenCount;
        acc.burned += entry.burnCount;
        return acc;
      },
      { accounts: 0, tokens: 0, burned: 0 },
    );

    return NextResponse.json({
      ok: true,
      aggregate,
      results,
    });
  } catch (error) {
    console.error("[thanks-demurrage] cron route failed:", error);
    return NextResponse.json({ error: "Demurrage run failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
