/**
 * @fileoverview TypeBadge - Renders a colored badge for entity types (org, ring, family, etc.).
 *
 * Used on cards and detail pages to visually distinguish entity types
 * with appropriate icons and color schemes.
 */
import { Badge } from "@/components/ui/badge"
import { Building2, FileJson, Network, Home, Users, User } from "lucide-react"
import { getEntityBadgeClass } from "@/lib/entity-style"

interface TypeBadgeProps {
  type: "org" | "json" | "ring" | "family" | "basic" | "person"
  showIcon?: boolean
}

/** Maps component-level type aliases to centralized entity type keys. */
const TYPE_TO_ENTITY_KEY: Record<TypeBadgeProps["type"], string> = {
  org: "organization",
  json: "group",      // JSON imports are treated as groups visually
  ring: "ring",
  family: "family",
  basic: "group",
  person: "person",
}

/** Maps component-level type aliases to display labels. */
const TYPE_DISPLAY_LABELS: Record<TypeBadgeProps["type"], string> = {
  org: "Org",
  json: "JSON",
  ring: "Ring",
  family: "Family",
  basic: "Basic",
  person: "Person",
}

/** Maps component-level type aliases to their icon components. */
const TYPE_ICONS: Record<TypeBadgeProps["type"], typeof Building2> = {
  org: Building2,
  json: FileJson,
  ring: Network,
  family: Home,
  basic: Users,
  person: User,
}

export const TypeBadge = ({ type, showIcon }: TypeBadgeProps) => {
  const entityKey = TYPE_TO_ENTITY_KEY[type]
  if (!entityKey) return null

  const badgeClass = getEntityBadgeClass(entityKey)
  const label = TYPE_DISPLAY_LABELS[type]
  const Icon = TYPE_ICONS[type]

  return (
    <Badge variant="secondary" className={badgeClass}>
      {showIcon && Icon && <Icon className="h-3 w-3 mr-1" />}
      {label}
    </Badge>
  )
}
