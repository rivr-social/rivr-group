import { NextResponse } from "next/server";
import { getLocalNodeFederationStatus } from "@/lib/federation";

/**
 * Node-level federation status for this instance, consumed by the post composer
 * to decide whether the federate-on-post toggle is available and to label it
 * ("Queue this post for export from <node> to N trusted peers").
 *
 * Distinct from `/api/federation/status`, which reports the manifest status of a
 * specific resource (and requires entityType/entityId). This endpoint is the
 * read-only self-node probe — it never bootstraps a node row.
 */
export async function GET() {
  try {
    const status = await getLocalNodeFederationStatus();
    return NextResponse.json({ success: true, ...status }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        enabled: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to resolve node federation status",
      },
      { status: 500 },
    );
  }
}
