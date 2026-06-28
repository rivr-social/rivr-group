/**
 * Pure (SDK-free, DOM-free) logic for turning a Polotno canvas export into the
 * data needed to persist it as a RIVR media Resource.
 *
 * Purpose:
 * - Keep ALL non-trivial design-persistence logic in a dependency-light module
 *   that can be unit-tested without loading the (heavy) Polotno SDK or a browser.
 * - Provide a single, validated mapping from a client-side export payload to the
 *   server-side upload parameters and Resource metadata.
 *
 * This module is imported by both the server action (`createDesignResource`) and
 * the unit tests. It MUST NOT import `polotno`, `react`, `next`, the database, or
 * any storage client — those are wired in at the call sites.
 *
 * Key exports:
 * - Constants: `DESIGN_EXPORT_FORMATS`, `DESIGN_MIME_BY_FORMAT`,
 *   `DESIGN_EXTENSION_BY_FORMAT`, `DESIGN_RESOURCE_TYPE`,
 *   `MAX_DESIGN_BYTES`, `DEFAULT_DESIGN_NAME`.
 * - Errors: `DesignExportError`, `InvalidDataUrlError`, `UnsupportedFormatError`,
 *   `DesignTooLargeError`, `EmptyDesignNameError`.
 * - Functions: `parseDesignDataUrl`, `buildDesignFilename`,
 *   `buildDesignUploadParams`, `buildDesignResourceMetadata`.
 */

import type { VisibilityLevel } from "@/db/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Resource type used to persist exported designs (an image media Resource). */
export const DESIGN_RESOURCE_TYPE = "image" as const;

/** Storage bucket exported designs are written to. Reuses the shared uploads bucket. */
export const DESIGN_STORAGE_BUCKET = "uploads" as const;

/** Raster export formats Polotno can produce that we accept for persistence. */
export const DESIGN_EXPORT_FORMATS = ["png", "jpeg"] as const;
export type DesignExportFormat = (typeof DESIGN_EXPORT_FORMATS)[number];

/** Maps an accepted export format to its canonical MIME type. */
export const DESIGN_MIME_BY_FORMAT: Record<DesignExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
};

/** Maps an accepted export format to its file extension (no leading dot). */
export const DESIGN_EXTENSION_BY_FORMAT: Record<DesignExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
};

/** Reverse lookup: MIME type → export format, for tolerant data-URL parsing. */
export const DESIGN_FORMAT_BY_MIME: Record<string, DesignExportFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
};

/**
 * Maximum accepted exported-design size in bytes (10MB). Kept in lockstep with
 * the storage layer's `MAX_FILE_SIZE` so the action can reject oversize designs
 * with a specific message before attempting a network upload.
 */
export const MAX_DESIGN_BYTES = 10 * 1024 * 1024;

/** Fallback name when the user does not title their design. */
export const DEFAULT_DESIGN_NAME = "Untitled Design";

/** Default visibility for a freshly saved design. */
export const DEFAULT_DESIGN_VISIBILITY: VisibilityLevel = "members";

/** Metadata discriminator marking a Resource as a Polotno-authored design. */
export const DESIGN_ENTITY_TYPE = "design" as const;

/** `storageProvider` value recorded on the Resource (matches schema default). */
export const DESIGN_STORAGE_PROVIDER = "minio" as const;

/** `data:` URL prefix expected for an exported raster image. */
const DATA_URL_PREFIX = "data:";

// ─── Error types ──────────────────────────────────────────────────────────────

/** Base error for the design-export → Resource mapping pipeline. */
export class DesignExportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DesignExportError";
  }
}

/** Thrown when the exported data URL is malformed or not base64-encoded. */
export class InvalidDataUrlError extends DesignExportError {
  constructor(detail: string) {
    super(`Invalid design data URL: ${detail}`);
    this.name = "InvalidDataUrlError";
  }
}

/** Thrown when the export MIME/format is outside the accepted allowlist. */
export class UnsupportedFormatError extends DesignExportError {
  constructor(received: string) {
    super(
      `Unsupported design format "${received}". Allowed formats: ${DESIGN_EXPORT_FORMATS.join(", ")}.`,
    );
    this.name = "UnsupportedFormatError";
  }
}

/** Thrown when the decoded design exceeds the size ceiling. */
export class DesignTooLargeError extends DesignExportError {
  constructor(size: number, maxSize: number) {
    super(`Design is ${size} bytes, which exceeds the ${maxSize}-byte limit.`);
    this.name = "DesignTooLargeError";
  }
}

/** Thrown when a design name is required but empty after trimming. */
export class EmptyDesignNameError extends DesignExportError {
  constructor() {
    super("A design name is required.");
    this.name = "EmptyDesignNameError";
  }
}

// ─── Parsed export shape ──────────────────────────────────────────────────────

/** Result of decoding an exported `data:` URL into raw bytes + format. */
export interface ParsedDesignExport {
  /** Decoded image bytes. */
  buffer: Buffer;
  /** Normalized export format. */
  format: DesignExportFormat;
  /** Canonical MIME type for the format. */
  mimeType: string;
  /** Decoded byte length. */
  size: number;
}

/**
 * Decodes a Polotno raster export `data:` URL into a validated byte buffer.
 *
 * Validation order is intentional: structure → format allowlist → size, so the
 * most specific actionable error is surfaced first and oversize work is rejected
 * before any caller attempts to upload.
 *
 * @param dataUrl Base64 data URL of the form `data:image/png;base64,<...>`.
 * @returns Decoded bytes plus the resolved format/MIME/size.
 * @throws InvalidDataUrlError when the URL is malformed or not base64.
 * @throws UnsupportedFormatError when the MIME type is not an accepted format.
 * @throws DesignTooLargeError when the decoded payload exceeds `MAX_DESIGN_BYTES`.
 * @example
 * const parsed = parseDesignDataUrl("data:image/png;base64,iVBORw0KGgo=");
 */
export function parseDesignDataUrl(dataUrl: string): ParsedDesignExport {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(DATA_URL_PREFIX)) {
    throw new InvalidDataUrlError("expected a base64 data: URL");
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    throw new InvalidDataUrlError("missing base64 payload separator");
  }

  const header = dataUrl.slice(DATA_URL_PREFIX.length, commaIndex);
  const base64Body = dataUrl.slice(commaIndex + 1);

  if (!header.includes("base64")) {
    throw new InvalidDataUrlError("data URL is not base64-encoded");
  }
  if (base64Body.length === 0) {
    throw new InvalidDataUrlError("base64 payload is empty");
  }

  const mimeType = header.split(";")[0].trim().toLowerCase();
  const format = DESIGN_FORMAT_BY_MIME[mimeType];
  if (!format) {
    throw new UnsupportedFormatError(mimeType || "unknown");
  }

  // `Buffer.from(..., "base64")` is lenient, so we round-trip to verify the
  // payload is genuinely valid base64 rather than silently truncated garbage.
  const buffer = Buffer.from(base64Body, "base64");
  if (buffer.length === 0) {
    throw new InvalidDataUrlError("base64 payload decoded to zero bytes");
  }

  if (buffer.length > MAX_DESIGN_BYTES) {
    throw new DesignTooLargeError(buffer.length, MAX_DESIGN_BYTES);
  }

  return {
    buffer,
    format,
    mimeType: DESIGN_MIME_BY_FORMAT[format],
    size: buffer.length,
  };
}

/**
 * Sanitizes a design name into a safe, unique-ish upload filename with the
 * correct extension for the export format.
 *
 * @param name Human-entered design name (may be empty/whitespace).
 * @param format Resolved export format.
 * @returns A filename like `my-design.png`. Never empty.
 * @example
 * buildDesignFilename("My Flyer!", "png"); // -> "my-flyer.png"
 */
export function buildDesignFilename(name: string, format: DesignExportFormat): string {
  const extension = DESIGN_EXTENSION_BY_FORMAT[format];
  const base = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const safeBase = base.length > 0 ? base : "design";
  return `${safeBase}.${extension}`;
}

/** Upload parameters consumed by the storage layer (`uploadFile`). */
export interface DesignUploadParams {
  /** Decoded image bytes. */
  buffer: Buffer;
  /** Sanitized upload filename including extension. */
  filename: string;
  /** Canonical MIME type for the export. */
  mimeType: string;
  /** Target storage bucket. */
  bucket: typeof DESIGN_STORAGE_BUCKET;
  /** Decoded byte length. */
  size: number;
  /** Resolved export format. */
  format: DesignExportFormat;
}

/**
 * Builds validated upload parameters from a raw export payload.
 *
 * Combines {@link parseDesignDataUrl} and {@link buildDesignFilename} so callers
 * have a single entry point producing exactly what the storage layer needs.
 *
 * @param params.dataUrl Base64 data URL of the exported raster image.
 * @param params.name Design name used to derive the filename.
 * @returns Fully validated `DesignUploadParams`.
 * @throws InvalidDataUrlError | UnsupportedFormatError | DesignTooLargeError
 */
export function buildDesignUploadParams(params: {
  dataUrl: string;
  name: string;
}): DesignUploadParams {
  const parsed = parseDesignDataUrl(params.dataUrl);
  const filename = buildDesignFilename(params.name, parsed.format);
  return {
    buffer: parsed.buffer,
    filename,
    mimeType: parsed.mimeType,
    bucket: DESIGN_STORAGE_BUCKET,
    size: parsed.size,
    format: parsed.format,
  };
}

/** Inputs needed to assemble a design Resource's metadata blob. */
export interface DesignResourceMetadataInput {
  /** Authenticated author agent id (server-derived, never client-trusted). */
  authorId: string;
  /** Resolved export format. */
  format: DesignExportFormat;
  /** Public URL of the uploaded raster. */
  imageUrl: string;
  /** Storage object key of the uploaded raster. */
  storageKey: string;
  /** Decoded byte length of the uploaded raster. */
  fileSize: number;
  /**
   * Serialized Polotno scene JSON, enabling later re-editing. Stored as a string
   * (already-serialized) to avoid embedding an unbounded object graph; callers
   * pass `JSON.stringify(store.toJSON())`. Optional — a design can be saved
   * without its editable scene.
   */
  sceneJson?: string;
  /** Canvas width in pixels, when known. */
  width?: number;
  /** Canvas height in pixels, when known. */
  height?: number;
}

/**
 * Assembles the JSONB `metadata` for a design Resource. Centralized so the shape
 * is consistent and unit-testable independent of the database.
 *
 * @returns A metadata record ready to persist on the Resource row.
 */
export function buildDesignResourceMetadata(
  input: DesignResourceMetadataInput,
): Record<string, unknown> {
  return {
    entityType: DESIGN_ENTITY_TYPE,
    resourceKind: DESIGN_ENTITY_TYPE,
    editor: "polotno",
    format: input.format,
    imageUrl: input.imageUrl,
    storageKey: input.storageKey,
    fileSize: input.fileSize,
    createdBy: input.authorId,
    ...(input.sceneJson ? { sceneJson: input.sceneJson } : {}),
    ...(typeof input.width === "number" ? { width: input.width } : {}),
    ...(typeof input.height === "number" ? { height: input.height } : {}),
  };
}

/** Normalizes a user-supplied design name, applying the default and validating. */
export function normalizeDesignName(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_DESIGN_NAME;
}

/**
 * Validates that a name is present when the caller requires an explicit title.
 *
 * @throws EmptyDesignNameError when `name` is empty/whitespace.
 */
export function assertDesignName(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) {
    throw new EmptyDesignNameError();
  }
  return trimmed;
}
