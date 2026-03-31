/**
 * @fileoverview TypeIcon - Renders an icon corresponding to an entity type.
 *
 * Used alongside TypeBadge and in entity cards to display the appropriate
 * Lucide icon for each entity type (org, ring, family, etc.).
 */
import { Building2, Package, GraduationCap, Network, Home, Users, User } from "lucide-react"
import { getEntityColor } from "@/lib/entity-style"

interface TypeIconProps {
  type: "org" | "package" | "graduation" | "ring" | "family" | "basic" | "person"
  className?: string
  size?: number
}

/** Maps component-level type aliases to centralized entity type keys for color lookup. */
const TYPE_TO_ENTITY_KEY: Record<TypeIconProps["type"], string> = {
  org: "organization",
  package: "product",
  graduation: "badge",
  ring: "ring",
  family: "family",
  basic: "group",
  person: "person",
}

/** Maps component-level type aliases to their Lucide icon components. */
const TYPE_ICON_MAP: Record<TypeIconProps["type"], typeof Building2> = {
  org: Building2,
  package: Package,
  graduation: GraduationCap,
  ring: Network,
  family: Home,
  basic: Users,
  person: User,
}

export function TypeIcon({ type, className, size }: TypeIconProps) {
  const Icon = TYPE_ICON_MAP[type]
  if (!Icon) return null

  const entityKey = TYPE_TO_ENTITY_KEY[type]
  const color = getEntityColor(entityKey)

  return <Icon className={className} size={size} style={{ color }} />
}
