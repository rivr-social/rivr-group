"use server";

/**
 * Server action: transcribe an audio/video source and LAND the transcript as a
 * doc Resource in the authenticated user's faceted vault.
 *
 * Identity is ALWAYS derived server-side via {@link resolveAuthenticatedUserId}
 * (the `auth()` session / federation execution context). Client-supplied owner
 * or author identity is never trusted (RIVR contributing rule #1).
 *
 * Sovereign adaptation: the person app's {@link transcribeAudioFile} is the
 * whisper/openai gateway variant (it throws a plain `Error` and is gated by
 * {@link isTranscriptionConfigured}), not global's three-provider
 * `TranscriptionError` variant. This action therefore checks configuration
 * up-front and maps generic transcription failures to the uniform
 * {@link ActionResult} error contract.
 */

import {
  transcribeAudioFile,
  isTranscriptionConfigured,
} from "@/lib/transcription";
import { buildTranscriptionDocPayload } from "@/lib/transcription-doc";
import { resolveAuthenticatedUserId, createResourceWithLedger } from "./helpers";
import type { ActionResult } from "./types";

/** Inputs for landing a transcript from a directly-supplied media File. */
export interface TranscribeAndLandDocInput {
  /** The audio/video media to transcribe. */
  file: File;
  /** Optional document title; falls back to a filename-derived/default title. */
  title?: string;
  /** Optional nested facet path under the `transcripts` root vault facet. */
  facetPath?: string[];
  /** Optional source URL recorded in the doc when media came from a link. */
  sourceUrl?: string;
}

/**
 * Transcribes the provided media file and creates a doc Resource (markdown body
 * = transcript) in the authenticated user's faceted vault.
 */
export async function transcribeAndLandDocAction(
  input: TranscribeAndLandDocInput,
): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to transcribe media.",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (!(input.file instanceof File)) {
    return {
      success: false,
      message: "An audio or video file is required.",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (!isTranscriptionConfigured()) {
    return {
      success: false,
      message: "Transcription is not configured on this deployment.",
      error: { code: "TRANSCRIPTION_UNAVAILABLE" },
    };
  }

  let transcript: string;
  let provider: Awaited<ReturnType<typeof transcribeAudioFile>>["provider"];
  try {
    const result = await transcribeAudioFile(input.file);
    transcript = result.text;
    provider = result.provider;
  } catch (error) {
    console.error("[transcribeAndLandDocAction] transcription failed:", error);
    return {
      success: false,
      message: "Failed to transcribe the media.",
      error: { code: "TRANSCRIPTION_FAILED" },
    };
  }

  // Identity is server-derived; never trust client-supplied owner/author.
  const payload = buildTranscriptionDocPayload({
    userId,
    transcript,
    provider,
    title: input.title,
    sourceFilename: input.file.name || undefined,
    sourceMimeType: input.file.type || undefined,
    sourceUrl: input.sourceUrl,
    facetPath: input.facetPath,
  });

  const created = await createResourceWithLedger(payload);
  if (!created.success) {
    return created;
  }

  return {
    success: true,
    message: "Transcript saved to your vault.",
    resourceId: created.resourceId,
  };
}
