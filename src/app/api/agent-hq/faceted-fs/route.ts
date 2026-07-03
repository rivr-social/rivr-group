import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { getAuthenticatedActorId } from "@/lib/server-auth";
import { canManage, isGroupMember } from "@/lib/permissions";
import {
  buildFacetedTree,
  parseFacetedTagsFromMetadata,
  type FacetedDoc,
} from "@/lib/parachute-doc";

export const dynamic = "force-dynamic";

/**
 * Resource types treated as faceted-FS "doc / data Resources". These carry a
 * markdown/text body and participate in the group's faceted virtual filesystem.
 * The group documents-tab creates docs as `document`; `note`/`dataset` are
 * accepted too so federated/imported doc rows also surface.
 */
const DOC_RESOURCE_TYPES = ["document", "note", "dataset"] as const;

/**
 * GET /api/agent-hq/faceted-fs?groupId=<uuid>
 *
 * Returns the GROUP agent's doc Resources (`ownerId = groupId`) arranged as a
 * faceted virtual filesystem (the "Tags" vault view). Each doc's
 * `metadata.facetedTags` tag-paths place it under multiple orthogonal folder
 * hierarchies at once; docs with no faceted tags fall back to depth-1 facets
 * derived from their flat `tags`, and otherwise land in an "Untagged" bucket.
 * Tags are an overlay/index only — per-resource visibility/ownership are
 * unaffected.
 *
 * Access gate: the viewer (resolved from a local session OR a federated
 * remote-viewer cookie) must be a member of the group, or hold manage/admin
 * rights on it. Non-members get 403; anonymous callers get 401.
 */
export async function GET(request: NextRequest) {
  try {
    const viewerId = await getAuthenticatedActorId();
    if (!viewerId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const groupId = request.nextUrl.searchParams.get("groupId");
    if (!groupId) {
      return NextResponse.json(
        { error: "groupId query parameter is required" },
        { status: 400 },
      );
    }

    // Members can view the group's doc vault; admins/owners (who may not hold a
    // plain join/belong edge) are covered by the manage check. This mirrors the
    // members-can-view gate the documents tab already relies on.
    const membership = await isGroupMember(viewerId, groupId);
    if (!membership.isMember) {
      const manage = await canManage(viewerId, groupId, "agent");
      if (!manage.allowed) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const rows = await db
      .select({
        id: resources.id,
        name: resources.name,
        tags: resources.tags,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, groupId),
          isNull(resources.deletedAt),
          inArray(resources.type, [...DOC_RESOURCE_TYPES]),
        ),
      )
      .orderBy(desc(resources.createdAt));

    const docs: FacetedDoc[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      tags: parseFacetedTagsFromMetadata(row.metadata, row.tags),
    }));

    const tree = buildFacetedTree(docs);

    return NextResponse.json({ tree, docCount: docs.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build faceted filesystem";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
