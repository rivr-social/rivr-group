/**
 * @fileoverview Site builder read + preview API (WS-B / B4).
 *
 * GET  /api/builder/site?targetAgentId=  -> current publication + version list
 * POST /api/builder/site?targetAgentId=  -> generate a fresh preview (not saved)
 *
 * Owner identity is derived server-side via the shared self-vs-group-admin gate
 * ({@link resolveSiteOwnerSubject}); `targetAgentId` only NAMES a group whose
 * site the caller may manage — it is authorized, never trusted as the owner.
 * Generation happens server-side so the client stays thin.
 */
import { NextResponse } from "next/server";

import {
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  generateSiteFiles,
  getSitePublication,
  listSiteVersions,
  resolveSiteOwnerSubject,
} from "@/lib/builder/site-service";
import type { SiteSectionId } from "@/lib/builder/site-model";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface PreviewBody {
  targetAgentId?: string;
  sections?: SiteSectionId[];
  theme?: string;
  siteTitle?: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const subject = await resolveSiteOwnerSubject(url.searchParams.get("targetAgentId") ?? undefined);
  if ("error" in subject) {
    return NextResponse.json({ error: subject.error }, { status: subject.status });
  }

  try {
    const [publication, versions] = await Promise.all([
      getSitePublication(subject.targetAgentId),
      listSiteVersions(subject.targetAgentId),
    ]);
    return NextResponse.json(
      { ownerId: subject.targetAgentId, publication, versions },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/site] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load site state" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: PreviewBody;
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: STATUS_BAD_REQUEST });
  }

  const subject = await resolveSiteOwnerSubject(body.targetAgentId);
  if ("error" in subject) {
    return NextResponse.json({ error: subject.error }, { status: subject.status });
  }

  try {
    const files = await generateSiteFiles(subject.targetAgentId, {
      sections: body.sections,
      theme: body.theme,
      siteTitle: body.siteTitle,
    });
    return NextResponse.json(
      { ownerId: subject.targetAgentId, files },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/site] preview failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate preview" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
