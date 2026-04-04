/**
 * GET  /api/kg/docs — List docs for a group scope
 * POST /api/kg/docs — Create a doc from a group resource
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as kg from "@/lib/kg/autobot-kg-client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const scopeType = url.searchParams.get("scope_type") || "group";
  const scopeId = url.searchParams.get("scope_id") || "";
  const status = url.searchParams.get("status") || undefined;

  if (!scopeId) {
    return NextResponse.json({ error: "scope_id is required for group KG" }, { status: 400 });
  }

  try {
    const docs = await kg.listDocs(scopeType, scopeId, status);
    return NextResponse.json(docs);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list docs" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { resourceId, scope_type, scope_id, title, doc_type } = body;

  if (!scope_id) {
    return NextResponse.json({ error: "scope_id (group ID) is required" }, { status: 400 });
  }

  if (resourceId) {
    const resource = await db.query.resources.findFirst({
      where: eq(resources.id, resourceId),
    });
    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    try {
      const doc = await kg.createDoc({
        title: title || resource.name || "Untitled",
        doc_type: doc_type || resource.type || "resource",
        scope_type: scope_type || "group",
        scope_id: scope_id,
        source_uri: `rivr://group/resources/${resource.id}`,
      });
      return NextResponse.json(doc);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create doc" },
        { status: 500 },
      );
    }
  }

  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  try {
    const doc = await kg.createDoc({
      title,
      doc_type: doc_type || "document",
      scope_type: scope_type || "group",
      scope_id: scope_id,
    });
    return NextResponse.json(doc);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create doc" },
      { status: 500 },
    );
  }
}
