/**
 * Client-safe subset of link-preview utilities.
 *
 * Reason this file exists:
 * - `create-post.tsx` is a "use client" component that needs to extract URLs
 *   from a textarea for preview fetching.
 * - The main `link-preview.ts` module imports `node:crypto` and
 *   `node:dns/promises` at module top (for server-side hashing and SSRF DNS
 *   resolution). When webpack bundles `create-post.tsx` for the browser, it
 *   tries to bundle the entire `link-preview.ts` transitively and chokes on
 *   those `node:`-scheme imports.
 * - Splitting the URL-extraction helpers into this pure, node-free module
 *   gives the client component something safe to import without pulling in
 *   the server-only dependencies.
 *
 * Keep this module free of Node built-ins, DB types, and server-only
 * imports. If a helper needs `crypto` / `dns` / `db` it belongs in
 * `link-preview.ts`.
 */

/**
 * URL extraction regex — matches `http://` or `https://` followed by a run of
 * non-whitespace characters. Tuned for social-post content, not RFC-strict.
 */
const URL_EXTRACTION_REGEX = /https?:\/\/[^\s<>]+/gi;

/** Punctuation commonly found at the end of a URL in prose that should be trimmed. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * Extract every http(s) URL from a block of text, de-duplicated while
 * preserving first-seen order. Trailing punctuation commonly seen in prose
 * ("See https://example.com.") is stripped.
 *
 * @param text Free-form user input (post body, comment, message).
 * @returns Ordered, de-duplicated list of raw URL strings.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(URL_EXTRACTION_REGEX);
  if (!matches) return out;
  for (const raw of matches) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION, '');
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
