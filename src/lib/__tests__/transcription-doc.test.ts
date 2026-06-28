/**
 * Tests for the pure transcript→doc mapping: faceted-tag placement, title
 * derivation, markdown rendering, and the full CreateResourceInput payload.
 * No model, DB, or auth is involved — these are pure-function tests.
 */

import { describe, it, expect } from "vitest";
import {
  buildTranscriptionDocPayload,
  buildTranscriptionFacetTags,
  deriveTranscriptionTitle,
  renderTranscriptMarkdown,
  sanitizeFacetSegment,
  DEFAULT_TRANSCRIPTION_TITLE,
  DEFAULT_TRANSCRIPTION_VISIBILITY,
  EMPTY_TRANSCRIPT_PLACEHOLDER,
  TRANSCRIPTION_ROOT_FACET,
  TRANSCRIPTION_RESOURCE_SUBTYPE,
} from "../transcription-doc";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TS = "2026-06-27T12:00:00.000Z";

describe("sanitizeFacetSegment", () => {
  it("lower-cases, hyphenates whitespace, strips unsafe chars", () => {
    expect(sanitizeFacetSegment("  Team Meetings!! ")).toBe("team-meetings");
    expect(sanitizeFacetSegment("2026/Q2")).toBe("2026/q2");
  });

  it("collapses repeated hyphens and trims edge separators", () => {
    expect(sanitizeFacetSegment("a   b")).toBe("a-b");
    expect(sanitizeFacetSegment("--edge--")).toBe("edge");
  });

  it("returns empty string for blank/invalid input", () => {
    expect(sanitizeFacetSegment("   ")).toBe("");
    expect(sanitizeFacetSegment(null)).toBe("");
    expect(sanitizeFacetSegment(undefined)).toBe("");
  });
});

describe("buildTranscriptionFacetTags", () => {
  it("always starts at the transcripts root facet", () => {
    expect(buildTranscriptionFacetTags()).toEqual([TRANSCRIPTION_ROOT_FACET]);
    expect(buildTranscriptionFacetTags([])).toEqual([TRANSCRIPTION_ROOT_FACET]);
  });

  it("nests sanitized facet segments under the root", () => {
    expect(buildTranscriptionFacetTags(["Meetings", "2026"])).toEqual([
      TRANSCRIPTION_ROOT_FACET,
      "meetings",
      "2026",
    ]);
  });

  it("drops blank/invalid segments", () => {
    expect(buildTranscriptionFacetTags(["  ", "Notes", ""])).toEqual([
      TRANSCRIPTION_ROOT_FACET,
      "notes",
    ]);
  });
});

describe("deriveTranscriptionTitle", () => {
  it("prefers an explicit title", () => {
    expect(deriveTranscriptionTitle({ title: " Board Call " })).toBe("Board Call");
  });

  it("derives from filename with extension stripped", () => {
    expect(deriveTranscriptionTitle({ sourceFilename: "standup-2026.mp4" })).toBe(
      `${DEFAULT_TRANSCRIPTION_TITLE}: standup-2026`,
    );
  });

  it("falls back to the default title", () => {
    expect(deriveTranscriptionTitle({})).toBe(DEFAULT_TRANSCRIPTION_TITLE);
    expect(deriveTranscriptionTitle({ sourceFilename: "   " })).toBe(DEFAULT_TRANSCRIPTION_TITLE);
  });
});

describe("renderTranscriptMarkdown", () => {
  it("renders header, source, provider, and body", () => {
    const md = renderTranscriptMarkdown({
      title: "Sync",
      transcript: "Hello there.",
      provider: "local",
      sourceFilename: "sync.webm",
      transcribedAt: TS,
    });
    expect(md).toContain("# Sync");
    expect(md).toContain("**Source:** sync.webm");
    expect(md).toContain("**Transcribed by:** local");
    expect(md).toContain(`**Transcribed at:** ${TS}`);
    expect(md.trim().endsWith("Hello there.")).toBe(true);
  });

  it("prefers a source URL over a filename", () => {
    const md = renderTranscriptMarkdown({
      title: "Sync",
      transcript: "x",
      provider: "openai",
      sourceFilename: "ignored.webm",
      sourceUrl: "https://example.com/clip.mp4",
      transcribedAt: TS,
    });
    expect(md).toContain("**Source:** https://example.com/clip.mp4");
    expect(md).not.toContain("ignored.webm");
  });

  it("uses a placeholder when transcript text is empty", () => {
    const md = renderTranscriptMarkdown({
      title: "Empty",
      transcript: "   ",
      provider: "whisper",
      transcribedAt: TS,
    });
    expect(md).toContain(EMPTY_TRANSCRIPT_PLACEHOLDER);
  });
});

describe("buildTranscriptionDocPayload", () => {
  it("maps a transcript to a personal-vault document payload", () => {
    const payload = buildTranscriptionDocPayload({
      userId: USER_ID,
      transcript: "The meeting began at noon.",
      provider: "local",
      sourceFilename: "meeting.m4a",
      sourceMimeType: "audio/mp4",
      facetPath: ["Meetings", "2026"],
      transcribedAt: TS,
    });

    expect(payload.type).toBe("document");
    // Identity → ownership is the authenticated user (personal faceted vault).
    expect(payload.ownerId).toBe(USER_ID);
    expect(payload.visibility).toBe(DEFAULT_TRANSCRIPTION_VISIBILITY);
    expect(payload.name).toBe(`${DEFAULT_TRANSCRIPTION_TITLE}: meeting`);
    // Faceted-tag location nests under the transcripts root.
    expect(payload.tags).toEqual([TRANSCRIPTION_ROOT_FACET, "meetings", "2026"]);
    // Markdown body carries the transcript text.
    expect(payload.content).toContain("The meeting began at noon.");

    const meta = payload.metadata as Record<string, unknown>;
    expect(meta.resourceKind).toBe("document");
    expect(meta.resourceSubtype).toBe(TRANSCRIPTION_RESOURCE_SUBTYPE);
    expect(meta.createdBy).toBe(USER_ID);
    expect(meta.transcriptionProvider).toBe("local");
    expect(meta.sourceFilename).toBe("meeting.m4a");
    expect(meta.sourceMimeType).toBe("audio/mp4");
    expect(meta.facetPath).toEqual([TRANSCRIPTION_ROOT_FACET, "meetings", "2026"]);
  });

  it("defaults facet location to the transcripts root when no path given", () => {
    const payload = buildTranscriptionDocPayload({
      userId: USER_ID,
      transcript: "hi",
      provider: "openai",
    });
    expect(payload.tags).toEqual([TRANSCRIPTION_ROOT_FACET]);
    expect(payload.name).toBe(DEFAULT_TRANSCRIPTION_TITLE);
  });

  it("throws when userId is missing (no client-trusted identity)", () => {
    expect(() =>
      buildTranscriptionDocPayload({
        userId: "",
        transcript: "x",
        provider: "local",
      }),
    ).toThrow(/server-derived userId/);
  });
});
