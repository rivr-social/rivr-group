"use client"

/**
 * Reusable empty state presentation component for feature sections with no content.
 *
 * Used in:
 * - Document-related views (and any other feature panels) to communicate an empty dataset.
 *
 * Key props:
 * - `title`: Primary empty-state message.
 * - `description`: Optional supporting context.
 * - `icon`: Optional visual cue for the empty state.
 * - `action`: Optional CTA with label and click callback.
 */
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: {
    label: string
    onClick: () => void
  }
}

/**
 * Displays standardized empty-state UI with optional icon and action.
 *
 * @param props Component props.
 * @param props.title Required heading text for the empty state.
 * @param props.description Optional body copy explaining the empty state.
 * @param props.icon Optional visual element rendered above the title.
 * @param props.action Optional CTA configuration containing button label and click handler.
 * @returns Centered empty-state layout for no-content scenarios.
 */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center p-8 my-8">
      {/* Conditional rendering: icon container is displayed only when an icon prop is provided. */}
      {icon && <div className="mb-4 text-muted-foreground">{icon}</div>}
      <h3 className="text-lg font-medium mb-2">{title}</h3>
      {/* Conditional rendering: description paragraph is omitted when no description is passed. */}
      {description && <p className="text-muted-foreground mb-4 max-w-md">{description}</p>}
      {/* Conditional rendering + event handler: CTA button renders only when action config exists. */}
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
