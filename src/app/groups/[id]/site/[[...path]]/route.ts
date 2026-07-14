/**
 * @fileoverview Public serve route for a group's published builder site
 * (Phase G / P-G4 — the "serve" leg of the builder core loop).
 *
 * GET /groups/[id]/site            -> serves the published site's index.html
 * GET /groups/[id]/site/style.css  -> serves a named file from the live snapshot
 *
 * The builder generates a static site from the owner's Resources and marks a
 * version live in `site_publications` (see `@/lib/builder/site-service`). This
 * route is the counterpart: it reads the owner's live publication and streams
 * the requested file straight from the version snapshot stored in the DB.
 *
 * Sovereign adaptation: this group instance has no A7 DNS connector lane, so
 * published sites are served under the instance's OWN host at this path rather
 * than bound to a custom domain (the documented boundary — the core
 * generate → publish → serve loop is fully functional without DNS binding).
 *
 * Public: `/groups` is an auth-optional page prefix, so an anonymous visitor
 * can view a published site. Only files that are part of the live snapshot are
 * ever served, and traversal is rejected, so nothing outside the published set
 * is reachable.
 */
import {
  STATUS_NOT_FOUND,
  STATUS_OK,
} from "@/lib/http-status";
import {
  getSitePublication,
  getSiteVersionFiles,
} from "@/lib/builder/site-service";
import { contentTypeFor, resolveSitePath, withSiteBase } from "@/lib/builder/site-serve";

export const dynamic = "force-dynamic";

/** UUID validation pattern (RFC 4122). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Published sites may be cached briefly by shared caches. */
const CACHE_CONTROL = "public, max-age=60";

/** Renders a minimal, self-contained 404 page for unpublished/missing files. */
function notFound(message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Not published</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0b0b0f;color:#f5f5f7"><main style="text-align:center;padding:2rem"><h1 style="margin:0 0 .5rem">Nothing here yet</h1><p style="opacity:.7">${message}</p></main></body></html>`;
  return new Response(html, {
    status: STATUS_NOT_FOUND,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> },
): Promise<Response> {
  const { id, path: segments } = await params;
  if (!id || !UUID_RE.test(id)) {
    return notFound("This site address is not valid.");
  }

  const requestedPath = resolveSitePath(segments);
  if (requestedPath === null) {
    return notFound("That path is not available.");
  }

  const publication = await getSitePublication(id);
  if (!publication?.publishedVersionId) {
    return notFound("This group has not published a site yet.");
  }

  const files = await getSiteVersionFiles(id, publication.publishedVersionId);
  const rawBody = files?.[requestedPath];
  if (typeof rawBody !== "string") {
    return notFound("That page could not be found on this site.");
  }

  const contentType = contentTypeFor(requestedPath);
  const body = contentType.startsWith("text/html")
    ? withSiteBase(rawBody, `/groups/${id}/site`)
    : rawBody;

  return new Response(body, {
    status: STATUS_OK,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
