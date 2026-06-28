/**
 * @fileoverview Owner-media read API for the Polotno design editor (WS-B / B3).
 *
 * GET /api/design/media?ownerAgentId=  -> { ownerId, items: OwnerMediaImage[] }
 *
 * Powers the editor's "My Photos" side panel: it returns the images that belong
 * to the OWNING agent, so designs are built from the owner's own media instead
 * of a third-party stock service.
 *
 * Sovereign adaptation: this person instance has no A7 `resolveConnectionSubject`
 * connections service (global-only). Owner identity is instead derived
 * server-side from the session via {@link resolveAuthenticatedUserId}; the
 * optional `ownerAgentId` only NAMES a group the caller may manage and is
 * authorized via {@link hasGroupWriteAccess} — it is never trusted as the owner.
 */
import { NextResponse } from "next/server";

import {
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
} from "@/app/actions/resource-creation/helpers";
import { collectOwnerMediaImages } from "@/lib/design/owner-media";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to load media." },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("ownerAgentId") ?? undefined;

  // Resolve the owner: self by default; a named group only if the caller has
  // write access to it. The owner is ALWAYS server-derived, never client-trusted.
  let ownerAgentId = userId;
  if (requested && requested !== userId) {
    const allowed = await hasGroupWriteAccess(userId, requested);
    if (!allowed) {
      return NextResponse.json(
        { error: "You do not manage that owner." },
        { status: STATUS_FORBIDDEN, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
    ownerAgentId = requested;
  }

  try {
    const items = await collectOwnerMediaImages(ownerAgentId);
    return NextResponse.json(
      { ownerId: ownerAgentId, items },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/design/media] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load media" },
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }
}
