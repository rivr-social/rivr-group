/**
 * @fileoverview Site builder publish API (WS-B / B4).
 *
 * POST /api/builder/publish
 * body: { targetAgentId?, sections?, theme?, siteTitle?, commitMessage? }
 *
 * Generates the owner's site server-side from their Resources, snapshots it as a
 * new `site_versions` row, and marks it live. Owner identity is derived
 * server-side via the shared self-vs-group-admin gate.
 */
import { NextResponse } from "next/server";

import { STATUS_BAD_REQUEST, STATUS_CREATED, STATUS_INTERNAL_ERROR } from "@/lib/http-status";
import { publishSite, resolveSiteOwnerSubject } from "@/lib/builder/site-service";
import type { SiteSectionId } from "@/lib/builder/site-model";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface PublishBody {
  targetAgentId?: string;
  sections?: SiteSectionId[];
  theme?: string;
  siteTitle?: string;
  commitMessage?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: PublishBody;
  try {
    body = (await request.json()) as PublishBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: STATUS_BAD_REQUEST });
  }

  const subject = await resolveSiteOwnerSubject(body.targetAgentId);
  if ("error" in subject) {
    return NextResponse.json({ error: subject.error }, { status: subject.status });
  }

  try {
    const result = await publishSite(subject.targetAgentId, {
      sections: body.sections,
      theme: body.theme,
      siteTitle: body.siteTitle,
      commitMessage: body.commitMessage,
    });
    return NextResponse.json(
      { ownerId: subject.targetAgentId, ...result },
      { status: STATUS_CREATED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/publish] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to publish site" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
