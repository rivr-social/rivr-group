const WHISPER_TRANSCRIBE_URL = process.env.WHISPER_TRANSCRIBE_URL?.trim();
const WHISPER_TRANSCRIBE_API_KEY = process.env.WHISPER_TRANSCRIBE_API_KEY?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

export type TranscriptionResult = {
  text: string;
  provider: "whisper" | "openai";
};

/**
 * Provider identifier for a completed transcription. Derived from
 * {@link TranscriptionResult} so the faceted-vault doc layer can name the
 * producing provider without re-declaring the union.
 */
export type TranscriptionProvider = TranscriptionResult["provider"];

export function isTranscriptionConfigured(): boolean {
  return Boolean(WHISPER_TRANSCRIBE_URL || OPENAI_API_KEY);
}

function extractTranscriptText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.text,
    record.transcript,
    record.output_text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

/** One timestamped span of a detailed transcription (milliseconds). */
export type TranscriptionSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type DetailedTranscriptionResult = TranscriptionResult & {
  /**
   * Timestamped segments when the provider supplies them (WhisperX does);
   * otherwise a single zero-anchored segment covering the full text.
   */
  segments: TranscriptionSegment[];
};

function extractTranscriptSegments(payload: unknown): TranscriptionSegment[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as Record<string, unknown>).segments;
  if (!Array.isArray(raw)) return [];

  const segments: TranscriptionSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const start = typeof record.start === "number" ? record.start : null;
    const end = typeof record.end === "number" ? record.end : null;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (start === null || end === null || !text) continue;
    // Whisper-family services report seconds; store milliseconds.
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text,
    });
  }
  return segments;
}

/**
 * Like {@link transcribeAudioFile} but preserves per-segment timestamps,
 * which the Virtual Meeting transcript merge needs to interleave speakers.
 */
export async function transcribeAudioFileDetailed(
  file: File,
): Promise<DetailedTranscriptionResult> {
  if (!isTranscriptionConfigured()) {
    throw new Error("Transcription is not configured on this deployment.");
  }

  if (WHISPER_TRANSCRIBE_URL) {
    const formData = new FormData();
    formData.append("file", file, file.name || "meeting-track.ogg");
    if (process.env.WHISPER_TRANSCRIBE_MODEL?.trim()) {
      formData.append("model", process.env.WHISPER_TRANSCRIBE_MODEL.trim());
    }
    const response = await fetch(WHISPER_TRANSCRIBE_URL, {
      method: "POST",
      headers: WHISPER_TRANSCRIBE_API_KEY
        ? { Authorization: `Bearer ${WHISPER_TRANSCRIBE_API_KEY}` }
        : undefined,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper transcription failed with status ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const text = extractTranscriptText(payload);
    if (!text) {
      throw new Error("Whisper transcription returned no text.");
    }
    const segments = extractTranscriptSegments(payload);
    return {
      text,
      provider: "whisper",
      segments:
        segments.length > 0 ? segments : [{ startMs: 0, endMs: 0, text }],
    };
  }

  const fallback = await transcribeAudioFile(file);
  return {
    ...fallback,
    segments: [{ startMs: 0, endMs: 0, text: fallback.text }],
  };
}

export async function transcribeAudioFile(file: File): Promise<TranscriptionResult> {
  if (!isTranscriptionConfigured()) {
    throw new Error("Transcription is not configured on this deployment.");
  }

  if (WHISPER_TRANSCRIBE_URL) {
    const formData = new FormData();
    formData.append("file", file, file.name || "event-segment.webm");
    if (process.env.WHISPER_TRANSCRIBE_MODEL?.trim()) {
      formData.append("model", process.env.WHISPER_TRANSCRIBE_MODEL.trim());
    }
    const response = await fetch(WHISPER_TRANSCRIBE_URL, {
      method: "POST",
      headers: WHISPER_TRANSCRIBE_API_KEY
        ? { Authorization: `Bearer ${WHISPER_TRANSCRIBE_API_KEY}` }
        : undefined,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper transcription failed with status ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const text = extractTranscriptText(payload);
    if (!text) {
      throw new Error("Whisper transcription returned no text.");
    }
    return { text, provider: "whisper" };
  }

  const formData = new FormData();
  formData.append("file", file, file.name || "event-segment.webm");
  formData.append("model", OPENAI_TRANSCRIPTION_MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with status ${response.status}`);
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractTranscriptText(payload);
  if (!text) {
    throw new Error("OpenAI transcription returned no text.");
  }

  return { text, provider: "openai" };
}
