/**
 * @fileoverview Pure helpers shared by BOTH published-site serve surfaces:
 * the instance path route (`/groups/[id]/site/[[...path]]`) and host-dispatch
 * (`/site-host` behind the middleware Host rewrite). No DB imports — the
 * routes load the snapshot; these decide path/content-type/HTML rewriting.
 */
import { INDEX_FILE } from "@/lib/builder/site-model";

/** Content types for the file extensions a generated site can contain. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};

/**
 * Resolves the requested site-relative path from catch-all segments to a
 * single snapshot key, defaulting to the index document and rejecting
 * traversal. Returns `null` when the path escapes the published set.
 */
export function resolveSitePath(segments: string[] | undefined): string | null {
  const joined = (segments ?? []).join("/").replace(/^\/+/, "");
  const path = joined === "" || joined.endsWith("/") ? `${joined}${INDEX_FILE}` : joined;
  if (path.split("/").some((part) => part === "..")) return null;
  return path;
}

/** Picks a content type from the file extension, defaulting to octet-stream. */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Anchors an HTML document's RELATIVE URLs to the site root. Next.js
 * canonicalizes `/groups/<id>/site/` to `/groups/<id>/site` (no trailing
 * slash), so a generated `<link href="style.css">` resolved against the PARENT
 * path and 404'd — the site rendered completely unstyled. A `<base>` tag pins
 * resolution to the snapshot root; documents that already declare one are left
 * untouched. Pass `"/"` for domain-root serving (host-dispatch).
 */
export function withSiteBase(html: string, siteRoot: string): string {
  if (/<base\s/i.test(html)) return html;
  const normalizedRoot = siteRoot.endsWith("/") ? siteRoot : `${siteRoot}/`;
  const baseTag = `<base href="${normalizedRoot}" />`;
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const insertAt = headOpen.index + headOpen[0].length;
    return `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`;
  }
  // Headless fragment — prepend so relative URLs still anchor correctly.
  return `${baseTag}${html}`;
}
