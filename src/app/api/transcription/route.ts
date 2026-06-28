/**
 * POST /api/transcription
 *
 * Accepts a multipart/form-data upload of an audio/video file, transcribes it
 * server-side, and lands the transcript as a doc Resource in the authenticated
 * user's faceted vault.
 *
 * Form fields:
 *  - `media`     (File, required)  — the audio/video to transcribe.
 *  - `title`     (string, optional) — document title override.
 *  - `facetPath` (string, optional) — JSON array OR slash-delimited path of
 *                                      facet segments nested under `transcripts`.
 *  - `sourceUrl` (string, optional) — original media URL, recorded in the doc.
 *
 * Identity is derived server-side inside the action via `auth()`; no caller
 * identity is trusted. The heavy `@xenova/transformers` local fallback is only
 * dynamically imported server-side and never reaches the client bundle.
 */

import { NextResponse } from "next/server";
import { transcribeAndLandDocAction } from "@/app/actions/resource-creation/transcription";

export const dynamic = "force-dynamic";
// Local Whisper inference and large-file decode can be slow; allow headroom.
export const maxDuration = 300;

const MEDIA_FIELD = "media";
const TITLE_FIELD = "title";
const FACET_PATH_FIELD = "facetPath";
const SOURCE_URL_FIELD = "sourceUrl";

/** Maps action error codes to HTTP status codes for a uniform API contract. */
const ERROR_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  INVALID_INPUT: 400,
  TRANSCRIPTION_UNAVAILABLE: 503,
  EMPTY_TRANSCRIPT: 422,
  TRANSCRIPTION_FAILED: 502,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  SERVER_ERROR: 500,
};

/**
 * Parses the `facetPath` form value, accepting either a JSON array of strings or
 * a slash-delimited path string. Returns `undefined` when absent/invalid.
 */
function parseFacetPath(raw: FormDataEntryValue | null): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((segment): segment is string => typeof segment === "string");
      }
    } catch {
      // Fall through to slash-splitting on malformed JSON.
    }
  }
  return value.split("/").filter((segment) => segment.length > 0);
}

export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const media = formData.get(MEDIA_FIELD);
  if (!(media instanceof File)) {
    return NextResponse.json(
      { error: "A media file is required." },
      { status: 400 },
    );
  }

  const titleRaw = formData.get(TITLE_FIELD);
  const sourceUrlRaw = formData.get(SOURCE_URL_FIELD);

  const result = await transcribeAndLandDocAction({
    file: media,
    title: typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : undefined,
    facetPath: parseFacetPath(formData.get(FACET_PATH_FIELD)),
    sourceUrl:
      typeof sourceUrlRaw === "string" && sourceUrlRaw.trim() ? sourceUrlRaw.trim() : undefined,
  });

  if (!result.success) {
    const status = ERROR_STATUS[result.error?.code ?? "SERVER_ERROR"] ?? 500;
    return NextResponse.json(
      { error: result.message, code: result.error?.code ?? "SERVER_ERROR" },
      { status },
    );
  }

  return NextResponse.json({
    success: true,
    resourceId: result.resourceId,
    message: result.message,
  });
}
