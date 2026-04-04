/**
 * POST /api/kg/graph — Query group-scoped KG subgraph
 * GET  /api/kg/graph — List entities in group scope
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { scope_type, scope_id, entity, predicate, max_results } = body;

  if (!scope_id) {
    return NextResponse.json({ error: "scope_id (group ID) is required" }, { status: 400 });
  }

  const scopeType = scope_type || "group";
  const scopeId = scope_id;

  try {
    const result = await kg.queryScope(scopeType, scopeId, {
      entity,
      predicate,
      max_results,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const scopeType = url.searchParams.get("scope_type") || "group";
  const scopeId = url.searchParams.get("scope_id") || "";

  if (!scopeId) {
    return NextResponse.json({ error: "scope_id is required" }, { status: 400 });
  }

  try {
    const entities = await kg.listEntities(scopeType, scopeId);
    return NextResponse.json(entities);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list entities" },
      { status: 500 },
    );
  }
}
