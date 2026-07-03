import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "liquid-glass inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 relative overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-white/10 bg-transparent text-[hsl(165,18%,22%)] hover:bg-white/[0.08] dark:text-primary-foreground",
        secondary:
          "border-white/10 bg-transparent text-[hsl(36,24%,26%)] hover:bg-white/[0.08] dark:text-secondary-foreground",
        destructive:
          "border-white/10 hover:opacity-90 bg-transparent text-[hsl(8,42%,28%)] dark:text-destructive-foreground",
        outline: "border-white/10 bg-transparent text-foreground",
        sage: "border-white/10 bg-transparent text-[hsl(140,25%,20%)] dark:text-emerald-200",
        ochre: "border-white/10 bg-transparent text-[hsl(40,40%,18%)] dark:text-amber-200",
        terracotta: "border-white/10 bg-transparent text-[hsl(16,35%,18%)] dark:text-orange-200",
        clay: "border-white/10 bg-transparent text-[hsl(25,20%,18%)] dark:text-stone-200",
        moss: "border-white/10 bg-transparent text-[hsl(90,22%,18%)] dark:text-lime-200",
        sand: "border-white/10 bg-transparent text-[hsl(45,25%,20%)] dark:text-yellow-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      <div className="liquid-glass-effect rounded-full" />
      <div className="liquid-glass-tint rounded-full" />
      <div className="liquid-glass-shine rounded-full" />
      <span className="relative z-[3]">{children}</span>
    </div>
  )
}

export { Badge, badgeVariants }
