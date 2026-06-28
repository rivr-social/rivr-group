/**
 * Pure mapping layer that turns a transcript into a RIVR **doc Resource**
 * payload for the parachute faceted vault.
 *
 * In RIVR, a "doc" is a `type: "document"` Resource whose `content` is a
 * markdown body and whose `tags` array is a nested/faceted "location" in the
 * user's vault (see `docs/active` faceted-vault notes and
 * `createResourceWithLedger`). This module contains ONLY pure functions so the
 * transcript→payload mapping, faceted-tag placement, and validation are unit
 * testable without any model, DB, or auth dependency.
 */

import type { CreateResourceInput } from "@/app/actions/resource-creation/types";
import type { TranscriptionProvider } from "@/lib/transcription";

/** Root facet under which all transcription docs are filed in the vault. */
export const TRANSCRIPTION_ROOT_FACET = "transcripts";

/**
 * Resource subtype marker (mirrors the `event-transcript` convention) so
 * transcription docs are queryable/distinguishable from hand-authored docs.
 */
export const TRANSCRIPTION_RESOURCE_SUBTYPE = "transcription";

/** Default document title when the caller/media provides none. */
export const DEFAULT_TRANSCRIPTION_TITLE = "Transcript";

/** Default vault visibility for a transcription doc: owner-only. */
export const DEFAULT_TRANSCRIPTION_VISIBILITY = "private" as const;

/** Marker appended to the markdown body when the transcript text is empty. */
export const EMPTY_TRANSCRIPT_PLACEHOLDER = "_No speech detected in the provided media._";

/** Inputs describing the source media and how to file the resulting doc. */
export interface TranscriptionDocInput {
  /** Authenticated user id (the vault owner + attributed author). Server-derived. */
  userId: string;
  /** Raw transcript text from the transcription provider. */
  transcript: string;
  /** Which provider produced the transcript (recorded in metadata + body). */
  provider: TranscriptionProvider;
  /** Optional human title; falls back to a media-derived or default title. */
  title?: string;
  /** Original media filename, used for title fallback and metadata. */
  sourceFilename?: string;
  /** Original media MIME type, recorded in metadata. */
  sourceMimeType?: string;
  /** Optional source URL when the media came from a link rather than upload. */
  sourceUrl?: string;
  /**
   * Additional facet path segments placed UNDER the root facet, e.g.
   * `["meetings", "2026"]` files the doc at `transcripts/meetings/2026`.
   */
  facetPath?: string[];
  /** ISO timestamp the transcription occurred; defaults to now() at call time. */
  transcribedAt?: string;
}

/**
 * Builds the faceted-tag array (the doc's vault "location") for a transcription
 * doc. The array is `[root, ...sanitizedFacetPath]` with blanks dropped and
 * segments lower-cased/slug-trimmed for stable nesting. Pure.
 */
export function buildTranscriptionFacetTags(facetPath?: string[]): string[] {
  const segments = Array.isArray(facetPath) ? facetPath : [];
  const sanitized = segments
    .map((segment) => sanitizeFacetSegment(segment))
    .filter((segment): segment is string => segment.length > 0);
  return [TRANSCRIPTION_ROOT_FACET, ...sanitized];
}

/**
 * Normalizes a single facet segment: trims, lower-cases, collapses internal
 * whitespace to single hyphens, and strips characters outside the safe set.
 * Returns "" for empty/invalid input so callers can drop it. Pure.
 */
export function sanitizeFacetSegment(segment: string | null | undefined): string {
  if (typeof segment !== "string") return "";
  return segment
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._/-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "");
}

/**
 * Derives a document title from explicit title, source filename (extension
 * stripped), or the default. Pure.
 */
export function deriveTranscriptionTitle(input: {
  title?: string;
  sourceFilename?: string;
}): string {
  const explicit = input.title?.trim();
  if (explicit) return explicit;

  const fromFile = input.sourceFilename?.trim();
  if (fromFile) {
    const withoutExt = fromFile.replace(/\.[^./\\]+$/, "").trim();
    if (withoutExt) return `${DEFAULT_TRANSCRIPTION_TITLE}: ${withoutExt}`;
  }

  return DEFAULT_TRANSCRIPTION_TITLE;
}

/**
 * Renders the markdown body of a transcription doc: a small front-matter-style
 * header (source/provider) followed by the transcript text. Pure.
 */
export function renderTranscriptMarkdown(input: {
  title: string;
  transcript: string;
  provider: TranscriptionProvider;
  sourceFilename?: string;
  sourceUrl?: string;
  transcribedAt: string;
}): string {
  const lines: string[] = [`# ${input.title}`, ""];

  const sourceRef = input.sourceUrl?.trim() || input.sourceFilename?.trim();
  if (sourceRef) {
    lines.push(`- **Source:** ${sourceRef}`);
  }
  lines.push(`- **Transcribed by:** ${input.provider}`);
  lines.push(`- **Transcribed at:** ${input.transcribedAt}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  const body = input.transcript.trim();
  lines.push(body.length > 0 ? body : EMPTY_TRANSCRIPT_PLACEHOLDER);

  return lines.join("\n");
}

/**
 * Maps a {@link TranscriptionDocInput} to the {@link CreateResourceInput}
 * accepted by `createResourceWithLedger`. The owner is the authenticated user
 * (personal vault); identity must already be server-derived by the caller. Pure.
 *
 * @throws {Error} if `userId` is missing (defense-in-depth; callers derive it
 *   from `auth()` server-side and must never pass client-supplied identity).
 */
export function buildTranscriptionDocPayload(
  input: TranscriptionDocInput,
): CreateResourceInput {
  if (!input.userId?.trim()) {
    throw new Error("buildTranscriptionDocPayload requires a server-derived userId.");
  }

  const transcribedAt = input.transcribedAt ?? new Date().toISOString();
  const title = deriveTranscriptionTitle({
    title: input.title,
    sourceFilename: input.sourceFilename,
  });
  const tags = buildTranscriptionFacetTags(input.facetPath);
  const content = renderTranscriptMarkdown({
    title,
    transcript: input.transcript,
    provider: input.provider,
    sourceFilename: input.sourceFilename,
    sourceUrl: input.sourceUrl,
    transcribedAt,
  });

  return {
    name: title,
    type: "document",
    ownerId: input.userId,
    description: `Transcript generated via ${input.provider}.`,
    content,
    tags,
    visibility: DEFAULT_TRANSCRIPTION_VISIBILITY,
    metadata: {
      entityType: "document",
      resourceKind: "document",
      resourceSubtype: TRANSCRIPTION_RESOURCE_SUBTYPE,
      createdBy: input.userId,
      transcriptionProvider: input.provider,
      sourceFilename: input.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceUrl: input.sourceUrl ?? null,
      transcribedAt,
      facetPath: tags,
    },
  };
}
