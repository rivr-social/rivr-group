"use client"

import { cn } from "@/lib/utils"

interface LiquidGlassProps {
  children: React.ReactNode
  className?: string
  as?: "div" | "section" | "article"
  /** Use the stronger displacement filter for hero/header surfaces. */
  strong?: boolean
}

/**
 * Liquid glass container that renders SVG displacement + backdrop-blur layers
 * behind its children. The effect references the `#glass-distortion` (subtle)
 * or `#glass-distortion-strong` SVG filter injected in the root layout.
 */
export function LiquidGlass({
  children,
  className,
  as: Tag = "div",
  strong = false,
}: LiquidGlassProps) {
  const effectClass = strong ? "liquid-glass-effect-strong" : "liquid-glass-effect"

  return (
    <Tag className={cn("liquid-glass rounded-xl", className)}>
      <div className={cn(effectClass, "rounded-xl")} />
      <div className="liquid-glass-tint rounded-xl" />
      <div className="liquid-glass-shine rounded-xl" />
      {children}
    </Tag>
  )
}
