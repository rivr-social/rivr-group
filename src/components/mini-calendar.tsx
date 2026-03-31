/**
 * @fileoverview MiniCalendar - Compact month-view calendar widget.
 *
 * Used on profile pages and sidebars to display a small navigable calendar
 * with date selection capability and event dot indicators.
 */
"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  isToday,
} from "date-fns"

interface MiniCalendarProps {
  selectedDate: Date
  onDateChange: (date: Date) => void
  events?: Array<{
    date: Date
    type: string
  }>
}

export function MiniCalendar({ selectedDate, onDateChange, events = [] }: MiniCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date(selectedDate))

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Get the day of the week for the first day of the month (0 = Sunday, 1 = Monday, etc.)
  const startDay = monthStart.getDay()

  // Create an array of days to display, including days from previous and next months
  const calendarDays = []

  // Add days from previous month
  for (let i = 0; i < startDay; i++) {
    const day = new Date(monthStart)
    day.setDate(day.getDate() - (startDay - i))
    calendarDays.push(day)
  }

  // Add days from current month
  calendarDays.push(...monthDays)

  // Add days from next month
  const remainingDays = 42 - calendarDays.length // 6 rows of 7 days
  for (let i = 1; i <= remainingDays; i++) {
    const day = new Date(monthEnd)
    day.setDate(day.getDate() + i)
    calendarDays.push(day)
  }

  // Group days into weeks
  const weeks = []
  for (let i = 0; i < calendarDays.length; i += 7) {
    weeks.push(calendarDays.slice(i, i + 7))
  }

  // Navigate to previous or next month
  const changeMonth = (direction: "prev" | "next") => {
    setCurrentMonth(direction === "prev" ? subMonths(currentMonth, 1) : addMonths(currentMonth, 1))
  }

  // Check if a day has events
  const getDayEvents = (day: Date) => {
    return events.filter((event) => isSameDay(event.date, day))
  }

  return (
    <div className="p-2">
      <div className="flex justify-between items-center mb-4">
        <Button variant="ghost" size="sm" onClick={() => changeMonth("prev")} aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h3 className="font-medium">{format(currentMonth, "MMMM yyyy")}</h3>
        <Button variant="ghost" size="sm" onClick={() => changeMonth("next")} aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((day, i) => (
          <div key={i} className="text-xs font-medium text-muted-foreground">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weeks.map((week, weekIndex) =>
          week.map((day, dayIndex) => {
            const dayEvents = getDayEvents(day)
            const isSelected = isSameDay(day, selectedDate)
            const isCurrentMonth = isSameMonth(day, currentMonth)
            const isCurrentDay = isToday(day)

            return (
              <Button
                key={`${weekIndex}-${dayIndex}`}
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 font-normal",
                  !isCurrentMonth && "text-muted-foreground opacity-50",
                  isSelected && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                  isCurrentDay && !isSelected && "border border-primary text-primary",
                )}
                onClick={() => onDateChange(day)}
              >
                <div className="relative w-full h-full flex items-center justify-center">
                  {format(day, "d")}
                  {dayEvents.length > 0 && (
                    <div className="absolute bottom-0.5 left-1/2 transform -translate-x-1/2 flex gap-0.5">
                      {dayEvents.length > 3 ? (
                        <div className="h-1 w-1 rounded-full bg-primary"></div>
                      ) : (
                        dayEvents.map((event, i) => (
                          <div
                            key={i}
                            className={cn(
                              "h-1 w-1 rounded-full",
                              event.type === "event"
                                ? "bg-green-500"
                                : event.type === "shift"
                                  ? "bg-blue-500"
                                  : "bg-purple-500",
                            )}
                          ></div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </Button>
            )
          }),
        )}
      </div>
    </div>
  )
}
