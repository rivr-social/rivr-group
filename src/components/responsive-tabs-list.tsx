"use client"

import type * as React from "react"

import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type ResponsiveTabsListProps = React.ComponentPropsWithoutRef<typeof TabsList> & {
  viewportClassName?: string
}

export function ResponsiveTabsList({
  className,
  viewportClassName,
  children,
  ...props
}: ResponsiveTabsListProps) {
  return (
    <div
      className={cn(
        "-mx-4 overflow-x-auto px-4 scrollbar-hide md:mx-0 md:px-0",
        viewportClassName,
      )}
    >
      <TabsList
        className={cn(
          "mx-auto inline-flex w-max min-w-full justify-start md:min-w-0 md:justify-center",
          className,
        )}
        {...props}
      >
        {children}
      </TabsList>
    </div>
  )
}
