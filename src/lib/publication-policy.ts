import type { VisibilityLevel } from "@/db/schema"

export type PublicationEntityKind =
  | "person"
  | "organization"
  | "ring"
  | "family"
  | "project"
  | "offer"
  | "post"
  | "event"

export type PublicationSurface = "search" | "murmurations" | "universal_manifest"

function normalizeVisibility(visibility?: string | null): VisibilityLevel | "private" {
  if (visibility === "public" || visibility === "locale" || visibility === "members" || visibility === "private") {
    return visibility
  }
  return "private"
}

export function inferGroupPublicationKind(meta: Record<string, unknown> | null | undefined): "organization" | "ring" | "family" {
  const groupType = String(meta?.groupType ?? "").toLowerCase()
  if (groupType === "ring") return "ring"
  if (groupType === "family") return "family"
  return "organization"
}

export function isAnonymousGroupPageVisible(
  meta: Record<string, unknown> | null | undefined,
  visibility?: string | null,
): boolean {
  const kind = inferGroupPublicationKind(meta)
  if (kind === "family") return false
  const normalized = normalizeVisibility(visibility)
  return normalized === "public" || normalized === "locale"
}

export function canPublishEntity(
  surface: PublicationSurface,
  entityKind: PublicationEntityKind,
  visibility?: string | null,
): boolean {
  const normalized = normalizeVisibility(visibility)

  if (entityKind === "family") return false

  if (entityKind === "organization" || entityKind === "ring") {
    return normalized === "public"
  }

  switch (surface) {
    case "search":
    case "murmurations":
    case "universal_manifest":
      return normalized === "public" || normalized === "locale"
    default:
      return false
  }
}

