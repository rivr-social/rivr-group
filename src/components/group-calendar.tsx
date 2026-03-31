"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  MapPin,
  ExternalLink,
  Briefcase,
  PartyPopper,
  FolderKanban,
} from "lucide-react"
import type { SerializedResource } from "@/lib/graph-serializers"

// ── Constants ──

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const TYPE_COLORS = {
  event: "bg-red-500",
  project: "bg-blue-500",
  job: "bg-green-500",
} as const

type CalendarItemType = keyof typeof TYPE_COLORS

interface CalendarItem {
  id: string
  title: string
  date: Date
  type: CalendarItemType
  color: string
  link: string
  time?: string
  location?: string
}

interface GroupCalendarProps {
  eventResources: SerializedResource[]
  projectResources: SerializedResource[]
  jobResources: SerializedResource[]
  groupName: string
}

// ── Helpers ──

const formatTime = (dateString: string) =>
  new Date(dateString).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })

const extractDate = (resource: SerializedResource, ...metaKeys: string[]): string | null => {
  const meta = resource.metadata ?? {}
  for (const key of metaKeys) {
    const value = meta[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

const toCalendarItem = (
  resource: SerializedResource,
  type: CalendarItemType,
  dateStr: string,
  linkPrefix: string,
): CalendarItem => {
  const meta = resource.metadata ?? {}
  const locationValue = typeof meta.location === "string" ? meta.location : undefined
  return {
    id: resource.id,
    title: resource.name,
    date: new Date(dateStr),
    type,
    color: TYPE_COLORS[type],
    link: `/${linkPrefix}/${resource.id}`,
    time: formatTime(dateStr),
    location: locationValue,
  }
}

// ── Component ──

export function GroupCalendar({
  eventResources,
  projectResources,
  jobResources,
  groupName,
}: GroupCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [viewMode, setViewMode] = useState<"month" | "week">("month")

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  // Build calendar items from resources
  const allCalendarItems = useMemo(() => {
    const items: CalendarItem[] = []

    for (const r of eventResources) {
      const dateStr = extractDate(r, "date", "startDate", "start")
      if (dateStr) items.push(toCalendarItem(r, "event", dateStr, "events"))
    }

    for (const r of projectResources) {
      const dateStr = extractDate(r, "startDate", "deadline", "date") ?? r.createdAt
      if (dateStr) items.push(toCalendarItem(r, "project", dateStr, "projects"))
    }

    for (const r of jobResources) {
      const dateStr = extractDate(r, "deadline", "startDate", "date") ?? r.createdAt
      if (dateStr) items.push(toCalendarItem(r, "job", dateStr, "jobs"))
    }

    return items
  }, [eventResources, projectResources, jobResources])

  // Calendar grid calculation
  const firstDayOfMonth = new Date(year, month, 1)
  const lastDayOfMonth = new Date(year, month + 1, 0)
  const daysInMonth = lastDayOfMonth.getDate()
  const startingDayOfWeek = firstDayOfMonth.getDay()

  const monthItems = useMemo(
    () => allCalendarItems.filter((item) => item.date.getFullYear() === year && item.date.getMonth() === month),
    [allCalendarItems, year, month],
  )

  const selectedDateItems = useMemo(
    () =>
      selectedDate
        ? allCalendarItems.filter((item) => item.date.toDateString() === selectedDate.toDateString())
        : [],
    [allCalendarItems, selectedDate],
  )

  // Generate calendar day cells
  const calendarDays = useMemo(() => {
    const days: (null | { day: number; date: Date; items: CalendarItem[] })[] = []
    for (let i = 0; i < startingDayOfWeek; i++) days.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day)
      const itemsForDay = monthItems.filter((item) => item.date.getDate() === day)
      days.push({ day, date, items: itemsForDay })
    }
    return days
  }, [startingDayOfWeek, daysInMonth, year, month, monthItems])

  // Week helpers
  const getWeekStart = (date: Date) => {
    const start = new Date(date)
    start.setDate(date.getDate() - date.getDay())
    return start
  }

  const weekDays = useMemo(() => {
    const weekStart = getWeekStart(currentDate)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart)
      d.setDate(weekStart.getDate() + i)
      return d
    })
  }, [currentDate])

  const weekItems = useMemo(() => {
    const weekStart = getWeekStart(currentDate)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    return allCalendarItems.filter((item) => item.date >= weekStart && item.date <= weekEnd)
  }, [allCalendarItems, currentDate])

  // Navigation
  const navigateMonth = (direction: "prev" | "next") => {
    setCurrentDate((prev) => {
      const d = new Date(prev)
      d.setMonth(d.getMonth() + (direction === "prev" ? -1 : 1))
      return d
    })
    setSelectedDate(null)
  }

  const navigateWeek = (direction: "prev" | "next") => {
    setCurrentDate((prev) => {
      const d = new Date(prev)
      d.setDate(d.getDate() + (direction === "prev" ? -7 : 7))
      return d
    })
    setSelectedDate(null)
  }

  const formatWeekRange = () => {
    const weekStart = getWeekStart(currentDate)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    if (weekStart.getMonth() === weekEnd.getMonth()) {
      return `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}-${weekEnd.getDate()}, ${weekStart.getFullYear()}`
    }
    return `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()} - ${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekStart.getFullYear()}`
  }

  const activeItems = viewMode === "month" ? monthItems : weekItems

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      {/* Calendar - takes 3 of 4 columns on large screens */}
      <div className="lg:col-span-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="flex items-center text-lg">
                <Calendar className="h-5 w-5 mr-2" />
                {groupName} Schedule
              </CardTitle>
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "month" | "week")}>
                <TabsList>
                  <TabsTrigger value="month">Month</TabsTrigger>
                  <TabsTrigger value="week">Week</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => (viewMode === "month" ? navigateMonth("prev") : navigateWeek("prev"))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="font-medium min-w-[220px] text-center">
                {viewMode === "month" ? `${MONTH_NAMES[month]} ${year}` : formatWeekRange()}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => (viewMode === "month" ? navigateMonth("next") : navigateWeek("next"))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {viewMode === "month" ? (
              <>
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {DAY_NAMES.map((d) => (
                    <div key={d} className="p-2 text-center text-sm font-medium text-muted-foreground">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((dayData, index) => {
                    const isToday = dayData?.date.toDateString() === new Date().toDateString()
                    const isSelected = selectedDate && dayData?.date.toDateString() === selectedDate.toDateString()
                    return (
                      <div
                        key={index}
                        className={`
                          min-h-[100px] p-1.5 border rounded-lg cursor-pointer transition-colors
                          ${dayData ? "hover:bg-accent/50" : ""}
                          ${isSelected ? "bg-blue-50 dark:bg-blue-950 border-blue-300 dark:border-blue-700" : "border-border"}
                          ${isToday && !isSelected ? "bg-accent/30 border-primary/30" : ""}
                        `}
                        onClick={() => dayData && setSelectedDate(dayData.date)}
                      >
                        {dayData && (
                          <>
                            <div className={`text-sm font-medium mb-1 ${isToday ? "text-primary font-bold" : ""}`}>
                              {dayData.day}
                            </div>
                            <div className="space-y-1">
                              {dayData.items.slice(0, 3).map((item) => (
                                <Link key={item.id} href={item.link}>
                                  <div
                                    className={`text-xs px-1.5 py-0.5 rounded text-white truncate hover:opacity-80 transition-opacity ${item.color}`}
                                    title={`${item.title} - Click to view`}
                                  >
                                    {item.title.length > 16 ? `${item.title.substring(0, 16)}...` : item.title}
                                  </div>
                                </Link>
                              ))}
                              {dayData.items.length > 3 && (
                                <div
                                  className="text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedDate(dayData.date)
                                  }}
                                >
                                  +{dayData.items.length - 3} more
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="grid grid-cols-7 gap-2">
                {weekDays.map((day, index) => {
                  const dayItems = weekItems.filter((item) => item.date.toDateString() === day.toDateString())
                  const isToday = day.toDateString() === new Date().toDateString()
                  const isSelected = selectedDate?.toDateString() === day.toDateString()
                  return (
                    <div key={index} className="border rounded-lg">
                      <div
                        className={`
                          p-2 text-center border-b cursor-pointer hover:bg-accent transition-colors
                          ${isToday ? "bg-blue-100 dark:bg-blue-950 text-blue-900 dark:text-blue-200" : "bg-muted/50"}
                          ${isSelected ? "bg-blue-200 dark:bg-blue-900" : ""}
                        `}
                        onClick={() => setSelectedDate(day)}
                      >
                        <div className="text-xs font-medium">{DAY_NAMES[day.getDay()]}</div>
                        <div className={`text-lg font-bold ${isToday ? "text-blue-900 dark:text-blue-200" : ""}`}>
                          {day.getDate()}
                        </div>
                      </div>
                      <div
                        className={`min-h-[220px] p-2 cursor-pointer transition-colors ${isSelected ? "bg-blue-50 dark:bg-blue-950/50" : "hover:bg-accent/30"}`}
                        onClick={() => setSelectedDate(day)}
                      >
                        <div className="space-y-2">
                          {dayItems.map((item) => (
                            <div
                              key={item.id}
                              className={`text-xs p-2 rounded text-white hover:opacity-80 transition-opacity cursor-pointer ${item.color}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                window.location.href = item.link
                              }}
                            >
                              <div className="font-medium truncate" title={item.title}>
                                {item.title.length > 20 ? `${item.title.substring(0, 20)}...` : item.title}
                              </div>
                              {item.time && <div className="text-white/80 mt-1">{item.time}</div>}
                              {item.location && (
                                <div className="text-white/70 text-xs mt-1 flex items-center">
                                  <MapPin className="h-3 w-3 mr-1" /> {item.location}
                                </div>
                              )}
                            </div>
                          ))}
                          {dayItems.length === 0 && (
                            <div className="text-xs text-muted-foreground text-center py-4">No items</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t">
              <span className="text-sm text-muted-foreground">Legend:</span>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-red-500 rounded" />
                <span className="text-xs text-muted-foreground">Events</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-blue-500 rounded" />
                <span className="text-xs text-muted-foreground">Projects</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-green-500 rounded" />
                <span className="text-xs text-muted-foreground">Jobs</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sidebar - selected date details + stats */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selectedDate
                ? selectedDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
                : "Select a Date"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate ? (
              selectedDateItems.length > 0 ? (
                <div className="space-y-3">
                  {selectedDateItems.map((item) => (
                    <div key={item.id} className="border rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <Link href={item.link}>
                          <h4 className="font-medium text-sm hover:text-blue-600 hover:underline cursor-pointer">
                            {item.title}
                          </h4>
                        </Link>
                        <Badge variant="secondary" className={`text-white text-xs ${item.color}`}>
                          {item.type}
                        </Badge>
                      </div>
                      <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                        {item.time && (
                          <div className="flex items-center">
                            <Clock className="h-3.5 w-3.5 mr-1.5" />
                            {item.time}
                          </div>
                        )}
                        {item.location && (
                          <div className="flex items-center">
                            <MapPin className="h-3.5 w-3.5 mr-1.5" />
                            {item.location}
                          </div>
                        )}
                        <div className="flex items-center">
                          {item.type === "event" && <PartyPopper className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type === "project" && <FolderKanban className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type === "job" && <Briefcase className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                        </div>
                      </div>
                      <div className="flex items-center justify-end mt-2 pt-2 border-t">
                        <Link href={item.link}>
                          <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Nothing scheduled for this day</p>
                </div>
              )
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Click a date to see scheduled items</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {viewMode === "month" ? "This Month" : "This Week"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Total Items</span>
                <span className="font-medium">{activeItems.length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Events</span>
                <span className="font-medium text-red-600">{activeItems.filter((i) => i.type === "event").length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Projects</span>
                <span className="font-medium text-blue-600">{activeItems.filter((i) => i.type === "project").length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Jobs</span>
                <span className="font-medium text-green-600">{activeItems.filter((i) => i.type === "job").length}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
