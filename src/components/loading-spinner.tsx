/**
 * @fileoverview LoadingSpinner - Configurable loading spinner component.
 *
 * Used throughout the app as a loading indicator. Supports sm, md, lg size variants.
 */
import { cn } from "@/lib/utils"

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg"
  className?: string
}

/**
 * LoadingSpinner component displays a loading indicator
 * It can be used to indicate that content is loading
 */
export function LoadingSpinner({ size = "md", className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: "h-4 w-4 border-2",
    md: "h-8 w-8 border-3",
    lg: "h-12 w-12 border-4",
  }

  return (
    <div className={cn("flex items-center justify-center", className)}>
      <div
        className={cn("animate-spin rounded-full border-solid border-primary border-t-transparent", sizeClasses[size])}
      />
    </div>
  )
}
