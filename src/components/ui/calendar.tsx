"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

// react-day-picker v9 wrapper. The classNames map below uses the v9 API keys
// (month_caption, button_previous, weekdays, day_button, range_*, …) — the
// pre-v9 keys (caption, nav_button, head_row, day_selected, …) are silently
// ignored by v9, which leaves the calendar unstyled. Range selection renders
// as a soft accent band per week row with filled endpoint pills.
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "w-full space-y-3",
        month_caption: "flex h-8 items-center px-1",
        caption_label: "text-base font-semibold tracking-tight",
        nav: "absolute right-1 top-0 z-10 flex h-8 items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "ghost" }),
          "h-7 w-7 p-0 text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost" }),
          "h-7 w-7 p-0 text-muted-foreground hover:text-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 text-[0.8rem] font-normal text-muted-foreground",
        week: "mt-1.5 flex w-full",
        day: "relative h-9 w-9 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 rounded-lg p-0 font-normal aria-selected:opacity-100",
        ),
        // Light theme has no teal token besides --background (the brand teal);
        // --primary is near-black there, so endpoint fills use --background with
        // dark: overrides to the dark theme's teal --primary.
        selected: "is-selected",
        range_start:
          "rounded-l-lg bg-[hsl(var(--background)/0.18)] dark:bg-accent/70 [&>button]:rounded-lg [&>button]:bg-[hsl(var(--background))] [&>button]:text-white [&>button]:hover:bg-[hsl(var(--background))] [&>button]:hover:text-white dark:[&>button]:bg-primary dark:[&>button]:text-primary-foreground dark:[&>button]:hover:bg-primary dark:[&>button]:hover:text-primary-foreground",
        range_middle:
          "bg-[hsl(var(--background)/0.18)] dark:bg-accent/70 first:rounded-l-lg last:rounded-r-lg [&>button]:rounded-none [&>button]:bg-transparent [&>button]:text-foreground",
        range_end:
          "rounded-r-lg bg-[hsl(var(--background)/0.18)] dark:bg-accent/70 [&>button]:rounded-lg [&>button]:bg-[hsl(var(--background))] [&>button]:text-white [&>button]:hover:bg-[hsl(var(--background))] [&>button]:hover:text-white dark:[&>button]:bg-primary dark:[&>button]:text-primary-foreground dark:[&>button]:hover:bg-primary dark:[&>button]:hover:text-primary-foreground",
        today:
          "[&:not(.is-selected)>button]:bg-transparent [&:not(.is-selected)>button]:font-semibold [&:not(.is-selected)>button]:text-[hsl(var(--background))] dark:[&:not(.is-selected)>button]:text-primary [&:not(.is-selected)>button]:ring-1 [&:not(.is-selected)>button]:ring-inset [&:not(.is-selected)>button]:ring-[hsl(var(--background)/0.5)] dark:[&:not(.is-selected)>button]:ring-primary/50",
        outside: "text-muted-foreground/50 [&>button]:text-muted-foreground/50",
        disabled: "opacity-40 [&>button]:pointer-events-none",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }: { orientation?: string }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      } as Record<string, unknown>}
      {...props}
    />
  )
}
Calendar.displayName = "Calendar"

export { Calendar }
