"use server";

/**
 * Server action for persisting a Polotno-authored design as a RIVR media Resource.
 *
 * Flow:
 * 1. Resolve the authenticated author server-side (never trust client identity).
 * 2. Validate & decode the exported raster via the pure `polotno-export` module.
 * 3. Upload the raster through the SHARED storage layer (`uploadFile` → MinIO),
 *    reusing the same validation/magic-byte/bucket path as `/api/upload`.
 * 4. Insert an `image` Resource (with storage columns populated) + a `create`
 *    ledger entry, atomically, mirroring the existing resource-creation actions.
 * 5. Emit a `resource.created` federation event (fire-and-forget), matching the
 *    pattern used by `createMutualAssetAction`.
 *
 * The heavy Polotno SDK never reaches the server: only the already-exported
 * data URL + serialized scene JSON cross the wire.
 */

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { resources, ledger } from "@/db/schema";
import type { NewLedgerEntry, NewResource, VisibilityLevel } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import {
  uploadFile,
  StorageError,
  FileSizeError,
  InvalidMimeTypeError,
  MagicByteMismatchError,
} from "@/lib/storage";
import { resolveAuthenticatedUserId } from "./helpers";
import type { ActionResult } from "./types";
import {
  buildDesignUploadParams,
  buildDesignResourceMetadata,
  normalizeDesignName,
  DESIGN_RESOURCE_TYPE,
  DESIGN_STORAGE_BUCKET,
  DESIGN_STORAGE_PROVIDER,
  DEFAULT_DESIGN_VISIBILITY,
  DesignExportError,
  InvalidDataUrlError,
  UnsupportedFormatError,
  DesignTooLargeError,
} from "@/lib/design/polotno-export";

/** Visibility values a client may request for a saved design. */
const VALID_DESIGN_VISIBILITIES: VisibilityLevel[] = [
  "public",
  "locale",
  "members",
  "private",
  "hidden",
];

/** Input contract for {@link createDesignResource}. */
export interface CreateDesignInput {
  /** Human-entered design name. Defaults to "Untitled Design" when empty. */
  name?: string;
  /** Optional short description. */
  description?: string;
  /** Base64 data URL of the exported raster (`data:image/png;base64,...`). */
  dataUrl: string;
  /** Serialized Polotno scene JSON (`JSON.stringify(store.toJSON())`) for re-editing. */
  sceneJson?: string;
  /** Canvas width in pixels, when known. */
  width?: number;
  /** Canvas height in pixels, when known. */
  height?: number;
  /** Requested visibility. Defaults to `members`. */
  visibility?: VisibilityLevel;
  /** Free-form tags. */
  tags?: string[];
}

/**
 * Resolves and validates the requested visibility, falling back to the default.
 */
function resolveVisibility(requested?: VisibilityLevel): VisibilityLevel {
  if (requested && VALID_DESIGN_VISIBILITIES.includes(requested)) {
    return requested;
  }
  return DEFAULT_DESIGN_VISIBILITY;
}

/**
 * Persists an exported Polotno design as an `image` Resource owned by the
 * authenticated user.
 *
 * Auth: caller must be authenticated; the owner is ALWAYS the server-resolved
 * user id — there is no client-supplied owner override.
 * Rate limiting: keyed by user id using the SOCIAL bucket (shared with other
 * resource-creation actions).
 *
 * @param input Design payload (export data URL + optional scene JSON/metadata).
 * @returns ActionResult with the new resource id and its public image URL.
 */
export async function createDesignResource(
  input: CreateDesignInput,
): Promise<ActionResult> {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to save a design.",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (typeof input?.dataUrl !== "string" || input.dataUrl.length === 0) {
    return {
      success: false,
      message: "No design image was provided.",
      error: { code: "INVALID_INPUT", details: "dataUrl is required" },
    };
  }

  const check = await rateLimit(
    `resources:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  // 1) Decode + validate the export (structure/format/size) before any I/O.
  let uploadParams;
  try {
    uploadParams = buildDesignUploadParams({
      dataUrl: input.dataUrl,
      name: normalizeDesignName(input.name),
    });
  } catch (error) {
    if (error instanceof DesignTooLargeError) {
      return {
        success: false,
        message: error.message,
        error: { code: "PAYLOAD_TOO_LARGE" },
      };
    }
    if (error instanceof UnsupportedFormatError) {
      return {
        success: false,
        message: error.message,
        error: { code: "UNSUPPORTED_MEDIA_TYPE" },
      };
    }
    if (error instanceof InvalidDataUrlError || error instanceof DesignExportError) {
      return {
        success: false,
        message: error.message,
        error: { code: "INVALID_INPUT" },
      };
    }
    return {
      success: false,
      message: "Failed to read the exported design.",
      error: { code: "SERVER_ERROR" },
    };
  }

  // 2) Upload through the shared storage layer (same path as /api/upload).
  let uploadResult;
  try {
    uploadResult = await uploadFile(
      uploadParams.buffer,
      uploadParams.filename,
      uploadParams.mimeType,
      DESIGN_STORAGE_BUCKET,
    );
  } catch (error) {
    if (error instanceof FileSizeError) {
      return { success: false, message: error.message, error: { code: "PAYLOAD_TOO_LARGE" } };
    }
    if (error instanceof InvalidMimeTypeError || error instanceof MagicByteMismatchError) {
      return { success: false, message: error.message, error: { code: "UNSUPPORTED_MEDIA_TYPE" } };
    }
    if (error instanceof StorageError) {
      console.error("[createDesignResource] storage error:", error);
      return {
        success: false,
        message: "Failed to store the design image.",
        error: { code: "SERVER_ERROR" },
      };
    }
    console.error("[createDesignResource] unexpected upload error:", error);
    return {
      success: false,
      message: "Failed to store the design image.",
      error: { code: "SERVER_ERROR" },
    };
  }

  // 3) Persist the Resource + ledger atomically.
  const name = normalizeDesignName(input.name);
  const visibility = resolveVisibility(input.visibility);
  const metadata = buildDesignResourceMetadata({
    authorId: userId,
    format: uploadParams.format,
    imageUrl: uploadResult.url,
    storageKey: uploadResult.key,
    fileSize: uploadResult.size,
    sceneJson: input.sceneJson,
    width: input.width,
    height: input.height,
  });

  let resourceId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(resources)
        .values({
          name,
          type: DESIGN_RESOURCE_TYPE,
          description: input.description?.trim() || null,
          url: uploadResult.url,
          contentType: uploadParams.mimeType,
          storageKey: uploadResult.key,
          storageProvider: DESIGN_STORAGE_PROVIDER,
          fileSize: uploadResult.size,
          ownerId: userId,
          visibility,
          tags: input.tags ?? [],
          metadata,
        } as NewResource)
        .returning({ id: resources.id });

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: created.id,
        objectType: "resource",
        resourceId: created.id,
        metadata: {
          resourceType: DESIGN_RESOURCE_TYPE,
          entityType: "design",
          source: "design-editor",
        },
      } as NewLedgerEntry);

      return created;
    });
    resourceId = result.id;
  } catch (error) {
    console.error("[createDesignResource] persistence error:", error);
    return {
      success: false,
      message: "Failed to save the design.",
      error: { code: "SERVER_ERROR" },
    };
  }

  // Surfaces where a newly saved design can appear.
  revalidatePath("/");
  revalidatePath("/create");
  revalidatePath("/profile");

  // 4) Fire-and-forget federation emit (matches createMutualAssetAction).
  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_CREATED,
    entityType: "resource",
    entityId: resourceId,
    actorId: userId,
    payload: { resourceType: DESIGN_RESOURCE_TYPE, entityType: "design" },
  }).catch(() => {});

  return {
    success: true,
    message: "Design saved successfully.",
    resourceId,
  };
}
