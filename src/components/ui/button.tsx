import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-transparent text-primary-foreground hover:bg-white/[0.08]",
        destructive:
          "bg-transparent text-destructive-foreground hover:bg-red-500/[0.12]",
        outline:
          "border border-white/10 bg-transparent hover:bg-white/[0.08] hover:text-accent-foreground",
        secondary:
          "bg-transparent text-secondary-foreground hover:bg-white/[0.08]",
        ghost: "bg-transparent hover:bg-white/[0.08] hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  glass?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, glass = true, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    const skipGlass = !glass || variant === "link" || asChild
    if (skipGlass) {
      return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>{children}</Comp>
    }
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size }),
          "liquid-glass relative overflow-hidden",
          className,
        )}
        ref={ref}
        {...props}
      >
        <div className="liquid-glass-effect rounded-md" />
        <div className="liquid-glass-tint rounded-md" />
        <div className="liquid-glass-shine rounded-md" />
        <span className="relative z-[3] inline-flex items-center gap-2">
          {children}
        </span>
      </Comp>
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
