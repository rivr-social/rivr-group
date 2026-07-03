import * as React from "react"

import { cn } from "@/lib/utils"

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <div className="liquid-glass relative rounded-md">
      <div className="liquid-glass-effect rounded-md" />
      <div className="liquid-glass-tint rounded-md" />
      <div className="liquid-glass-shine rounded-md" />
      <textarea
        className={cn(
          "relative z-[3] flex min-h-[80px] w-full rounded-md border border-white/10 bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    </div>
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
