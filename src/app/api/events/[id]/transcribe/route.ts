import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId } from "@/app/actions/resource-creation/helpers";
import { appendEventTranscriptAction } from "@/app/actions/interactions/events-jobs";
import { getEventTranscriptDocument } from "@/lib/queries/resources";
import { isTranscriptionConfigured, transcribeAudioFile } from "@/lib/transcription";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!isTranscriptionConfigured()) {
    return NextResponse.json({ error: "Transcription is not configured on this deployment." }, { status: 503 });
  }

  const { id: eventId } = await params;
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("audio");
  const speakerLabel = formData?.get("speakerLabel");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
  }

  try {
    const transcription = await transcribeAudioFile(file);
    const appendResult = await appendEventTranscriptAction({
      eventId,
      text: transcription.text,
      speakerLabel: typeof speakerLabel === "string" ? speakerLabel : null,
      source: transcription.provider === "whisper" ? "whisper" : "whisper-gateway",
    });

    if (!appendResult.success) {
      return NextResponse.json({ error: appendResult.message }, { status: 403 });
    }

    const transcript = await getEventTranscriptDocument(eventId);
    return NextResponse.json({
      success: true,
      text: transcription.text,
      transcriptDocumentId: appendResult.linkedDocumentId ?? appendResult.resourceId ?? null,
      transcriptContent: transcript?.content ?? "",
    });
  } catch (error) {
    console.error("[event-transcribe] failed:", error);
    return NextResponse.json({ error: "Failed to transcribe audio." }, { status: 500 });
  }
}
