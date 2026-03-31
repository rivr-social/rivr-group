"use client"

import { useState, useMemo } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useHomeFeed } from "@/lib/hooks/use-graph-data"
import { CalendarEvent } from "@/components/calendar-event"
import { Badge } from "@/components/ui/badge"
import { ChevronLeft, ChevronRight, Filter, Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameDay,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  getDay,
  isToday,
  isSameMonth,
} from "date-fns"
import { useRouter } from "next/navigation"
import { Calendar, Briefcase, Check } from "lucide-react"

/**
 * Calendar page for viewing and filtering personal schedule items across day/week/month/agenda views.
 *
 * Route: `/calendar` (App Router page segment).
 * Data requirements: consumes `useHomeFeed()` graph data (events/groups) and derives
 * calendar-ready models, while shift/task data remain placeholder arrays until those sources are connected.
 *
 * Rendering: client-rendered (`"use client"`) because it depends on local state, memoized derivations,
 * and client navigation hooks.
 * Metadata: this file does not export route metadata.
 * Auth/redirects: no auth gate or automatic redirect logic is implemented here.
 */
type CalendarItem = {
  id: string
  name: string
  start: Date
  end: Date
  type: string
  color: string
  colorClass: string
  projectName?: string
  projectId?: string
  groupName?: string
  groupId?: string
  location?: string
}

/**
 * Renders the interactive calendar experience and all view-specific event layouts.
 *
 * @returns The Calendar page content.
 */
export default function CalendarPage() {
  const [date, setDate] = useState<Date>(new Date())
  const [view, setView] = useState("week")
  // NOTE: Shifts and tasks filters removed — no shift/task data model exists yet.
  // Re-add when shift/task resource types and DB tables are implemented.
  const [filters, setFilters] = useState({
    events: true,
  })
  const [searchQuery, setSearchQuery] = useState("")
  const router = useRouter()
  // Client-side graph fetch for events and related groups used throughout derived calendar state.
  const { data: graphData, state: graphState } = useHomeFeed()

  // Guard against rendering partial event data until the feed reports loaded.
  const sourceEvents = useMemo(() => graphState === "loaded" ? graphData.events : [], [graphState, graphData.events])

  // Lookup map used to resolve organizer group IDs to human-readable group names.
  const groupIndex = useMemo(() => {
    const index = new Map<string, string>()
    for (const group of graphData.groups) {
      index.set(group.id, group.name)
    }
    return index
  }, [graphData.groups])

  // Normalize graph events into the `CalendarItem` shape consumed by each calendar view.
  const userEvents = useMemo<(CalendarItem | null)[]>(() => sourceEvents
    .map((event) => {
      // Handle both timeframe.start and startDate formats
      const ev = event as Record<string, unknown>
      const startDate = (event.timeframe?.start || (ev.startDate as string) || new Date().toISOString()) as string
      const endDate = (event.timeframe?.end || startDate) as string

      if (!startDate) return null // Skip events without timeframe

      return {
        id: event.id,
        name: event.name || (ev.title as string) || "Untitled Event",
        groupId: event.organizer && groupIndex.has(event.organizer) ? event.organizer : undefined,
        groupName: event.organizer ? groupIndex.get(event.organizer) : undefined,
        start: new Date(startDate),
        end: new Date(endDate),
        location: typeof event.location === "string" ? event.location : event.location?.address,
        type: "event",
        color: "bg-green-500",
        colorClass: "border-green-500 bg-green-50",
      }
    })
    .filter(Boolean), [sourceEvents, groupIndex])

  // Build final calendar dataset based on active filters and search text.
  const allCalendarItems = useMemo(() => {
    let items = [
      ...(filters.events ? userEvents : []),
    ].filter((item): item is NonNullable<typeof item> => item !== null)

    // Ensure all dates are valid
    items = items.filter((item) => {
      try {
        return (
          item &&
          item.start instanceof Date &&
          !isNaN(item.start.getTime()) &&
          item.end instanceof Date &&
          !isNaN(item.end.getTime())
        )
      } catch (error) {
        console.error("Invalid date in calendar item:", item, error)
        return false
      }
    })

    // Apply search filter if there's a query
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      items = items.filter(
        (item) =>
          item &&
          (item.name?.toLowerCase().includes(query) ||
          item.projectName?.toLowerCase().includes(query) ||
          item.groupName?.toLowerCase().includes(query) ||
          item.location?.toLowerCase().includes(query))
      )
    }

    return items
  }, [filters.events, searchQuery, userEvents])

  // Day view only: include entries that start on the currently selected date.
  const selectedDateEvents = useMemo(() => {
    if (view === "day") {
      return allCalendarItems.filter((event) => isSameDay(event.start, date))
    }
    return []
  }, [view, date, allCalendarItems])

  // Freeze the "now" window for this render session to keep agenda filtering stable.
  const [now] = useState(() => new Date())
  const [oneWeekLater] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return d
  })

  // Agenda view only: show events scheduled in the next 7 days.
  const upcomingEvents = useMemo(() => {
    if (view === "upcoming") {
      return allCalendarItems
        .filter((event) => event.start >= now && event.start <= oneWeekLater)
        .sort((a, b) => a.start.getTime() - b.start.getTime())
    }
    return []
  }, [view, allCalendarItems, now, oneWeekLater])

  // Week view only: constrain events to the selected week boundaries.
  const weekEvents = useMemo(() => {
    if (view === "week") {
      const weekStart = startOfWeek(date, { weekStartsOn: 0 }) // 0 = Sunday
      const weekEnd = endOfWeek(date, { weekStartsOn: 0 })

      return allCalendarItems.filter((event) => event.start >= weekStart && event.start <= weekEnd)
    }
    return []
  }, [view, date, allCalendarItems])

  // Render model for the week header/body grid.
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(date, { weekStartsOn: 0 })
    const weekEnd = endOfWeek(date, { weekStartsOn: 0 })

    return eachDayOfInterval({ start: weekStart, end: weekEnd })
  }, [date])

  // Month boundary values used to construct the month grid.
  const monthStart = useMemo(() => startOfMonth(date), [date])
  const monthEnd = useMemo(() => endOfMonth(date), [date])
  const monthDays = useMemo(() => {
    // Get all days in the month
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd })

    // Get the first day of the month (0 = Sunday, 1 = Monday, etc.)
    const startDay = getDay(monthStart)

    // Get days from previous month to fill the first week
    const prevMonthDays =
      startDay > 0
        ? eachDayOfInterval({
            start: new Date(monthStart.getFullYear(), monthStart.getMonth(), -startDay + 1),
            end: new Date(monthStart.getFullYear(), monthStart.getMonth(), 0),
          })
        : []

    // Get days from next month to fill the last week
    const endDay = getDay(monthEnd)
    const nextMonthDays =
      endDay < 6
        ? eachDayOfInterval({
            start: new Date(monthEnd.getFullYear(), monthEnd.getMonth() + 1, 1),
            end: new Date(monthEnd.getFullYear(), monthEnd.getMonth() + 1, 6 - endDay),
          })
        : []

    return [...prevMonthDays, ...daysInMonth, ...nextMonthDays]
  }, [monthStart, monthEnd])

  // Month view only: include events visible in the full month grid window.
  const monthEvents = useMemo(() => {
    if (view === "month") {
      const monthViewStart = monthDays[0]
      const monthViewEnd = monthDays[monthDays.length - 1]

      return allCalendarItems.filter((event) => event.start >= monthViewStart && event.start <= monthViewEnd)
    }
    return []
  }, [view, monthDays, allCalendarItems])

  /**
   * Resets the current calendar anchor date to today.
   */
  const navigateToToday = () => {
    setDate(new Date())
  }

  /**
   * Moves the current date backward/forward relative to the active view granularity.
   *
   * @param direction Whether to navigate to the previous or next period.
   */
  const navigateDate = (direction: "prev" | "next") => {
    if (view === "day") {
      const newDate = new Date(date)
      newDate.setDate(newDate.getDate() + (direction === "prev" ? -1 : 1))
      setDate(newDate)
    } else if (view === "week") {
      setDate(direction === "prev" ? subWeeks(date, 1) : addWeeks(date, 1))
    } else if (view === "month") {
      setDate(direction === "prev" ? subMonths(date, 1) : addMonths(date, 1))
    }
  }

  /**
   * Toggles inclusion of a calendar item category in the rendered dataset.
   *
   * @param filterName Filter key to toggle.
   */
  const toggleFilter = (filterName: keyof typeof filters) => {
    setFilters((prev) => ({
      ...prev,
      [filterName]: !prev[filterName],
    }))
  }

  /**
   * Navigates to the event creation flow from a user action.
   * This is explicit client navigation, not an automatic redirect.
   */
  const handleCreateEvent = () => router.push("/create?tab=event")

  if (graphState === "loading") {
    return (
      <div className="container max-w-4xl mx-auto px-4 py-6">
        <div className="flex justify-between items-center mb-6">
          <div className="h-8 w-40 animate-pulse bg-muted rounded" />
          <div className="flex gap-2">
            <div className="h-9 w-28 animate-pulse bg-muted rounded-md" />
            <div className="h-9 w-20 animate-pulse bg-muted rounded-md" />
          </div>
        </div>
        {/* Tab bar skeleton */}
        <div className="flex justify-between items-center mb-4">
          <div className="flex gap-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 w-16 animate-pulse bg-muted rounded-md" />
            ))}
          </div>
          <div className="flex gap-2">
            <div className="h-8 w-8 animate-pulse bg-muted rounded" />
            <div className="h-8 w-16 animate-pulse bg-muted rounded-md" />
            <div className="h-8 w-8 animate-pulse bg-muted rounded" />
          </div>
        </div>
        {/* Week grid skeleton */}
        <div className="bg-card rounded-lg shadow-sm border p-4 mb-6">
          <div className="h-6 w-56 animate-pulse bg-muted rounded" />
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-2 p-2">
              <div className="h-4 w-8 mx-auto animate-pulse bg-muted rounded" />
              <div className="h-8 w-8 mx-auto animate-pulse bg-muted rounded-full" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1 mt-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="border rounded-md min-h-[200px] p-2 space-y-2">
              <div className="h-4 w-full animate-pulse bg-muted rounded" />
              <div className="h-4 w-3/4 animate-pulse bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">My Calendar</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCreateEvent}>
            <Plus className="h-4 w-4 mr-2" />
            New Event
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <Filter className="h-4 w-4 mr-2" />
                Filter
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56">
              <div className="space-y-4">
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Show on calendar</h4>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="filter-events"
                        checked={filters.events}
                        onCheckedChange={() => toggleFilter("events")}
                      />
                      <Label htmlFor="filter-events" className="flex items-center">
                        <div className="w-3 h-3 rounded-full bg-green-500 mr-2"></div>
                        Events
                      </Label>
                    </div>
                    {/* Shifts and Tasks filters removed — no data model yet. Re-add when implemented. */}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Search</h4>
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search events..."
                      className="pl-8"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Tab state drives all conditional rendering for view-specific headings and content. */}
      <Tabs defaultValue={view} className="w-full" onValueChange={setView} value={view}>
        <div className="flex justify-between items-center mb-4">
          <TabsList className="grid grid-cols-4">
            <TabsTrigger value="day">Day</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="upcoming">Agenda</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigateDate("prev")} aria-label="Previous period">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={navigateToToday}>
              Today
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigateDate("next")} aria-label="Next period">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="bg-card rounded-lg shadow-sm border p-4 mb-6">
          {/* Conditional rendering: day-view heading and "Today" badge. */}
          {view === "day" && (
            <h2 className="text-xl font-medium">
              {format(date, "EEEE, MMMM d, yyyy")}
              {isToday(date) && <Badge className="ml-2 bg-primary">Today</Badge>}
            </h2>
          )}

          {/* Conditional rendering: week-range heading and current-week indicator. */}
          {view === "week" && (
            <h2 className="text-xl font-medium">
              {format(weekDays[0], "MMMM d")} - {format(weekDays[6], "MMMM d, yyyy")}
              {weekDays.some((day) => isToday(day)) && <Badge className="ml-2 bg-primary">Current Week</Badge>}
            </h2>
          )}

          {/* Conditional rendering: month heading. */}
          {view === "month" && <h2 className="text-xl font-medium">{format(date, "MMMM yyyy")}</h2>}

          {/* Conditional rendering: agenda heading. */}
          {view === "upcoming" && <h2 className="text-xl font-medium">Upcoming Events</h2>}
        </div>

        <TabsContent value="day" className="mt-0">
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              {Array.from({ length: 24 }).map((_, hour) => {
                const hourEvents = selectedDateEvents.filter((event) => {
                  const eventHour = event.start.getHours()
                  return eventHour === hour
                })

                return (
                  <div key={hour} className="flex">
                    <div className="w-16 text-right pr-4 text-muted-foreground text-sm py-2">
                      {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
                    </div>
                    <div className="flex-1 min-h-[60px] border-t relative">
                      {/* Conditional rendering: display hour cards only when events fall in this hour. */}
                      {hourEvents.length > 0 ? (
                        <div className="absolute top-1 left-0 right-0">
                          {hourEvents.map((event) => (
                            <div
                              key={`${event.type}-${event.id}`}
                              className={`mb-1 p-2 rounded-md border-l-4 ${event.colorClass}`}
                            >
                              <div className="flex justify-between items-start">
                                <div className="flex items-center gap-2">
                                  <div
                                    className={`rounded-full p-1 ${
                                      event.type === "event"
                                        ? "bg-green-100 text-green-500"
                                        : event.type === "shift"
                                          ? "bg-blue-100 text-blue-500"
                                          : "bg-purple-100 text-purple-500"
                                    }`}
                                  >
                                    {event.type === "event" ? (
                                      <Calendar className="h-4 w-4" />
                                    ) : event.type === "shift" ? (
                                      <Briefcase className="h-4 w-4" />
                                    ) : (
                                      <Check className="h-4 w-4" />
                                    )}
                                  </div>
                                  <div>
                                    <p className="font-medium">{event.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {format(event.start, "h:mm a")} - {format(event.end, "h:mm a")}
                                    </p>
                                    {event.projectName && <p className="text-xs">{event.projectName}</p>}
                                  </div>
                                </div>
                                <Badge variant="outline" className="capitalize">
                                  {event.type}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="week" className="mt-0">
          <div className="grid grid-cols-7 gap-1">
            {weekDays.map((day, _index) => (
              <div key={day.toISOString()} className="text-center p-2">
                <div className={`font-medium mb-1 ${isToday(day) ? "text-primary" : ""}`}>{format(day, "EEE")}</div>
                <div
                  className={`
                    rounded-full w-8 h-8 mx-auto flex items-center justify-center
                    ${isToday(day) ? "bg-primary text-white" : ""}
                  `}
                >
                  {format(day, "d")}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1 mt-2">
            {weekDays.map((day) => {
              const dayEvents = weekEvents.filter((event) => isSameDay(event.start, day))
              const isCurrentDay = isToday(day)

              return (
                <div
                  key={day.toISOString()}
                  className={`border rounded-md min-h-[200px] ${isCurrentDay ? "bg-primary/5 border-primary" : ""}`}
                >
                  <div className="p-1 space-y-1">
                    {/* Conditional rendering: event chips or explicit empty state per day. */}
                    {dayEvents.length > 0 ? (
                      dayEvents.map((event) => (
                        <div
                          key={`${event.type}-${event.id}`}
                          className={`p-1 text-xs rounded border-l-2 ${event.colorClass} truncate`}
                        >
                          <div className="flex items-center gap-1">
                            {event.type === "event" ? (
                              <Calendar className="h-3 w-3 text-green-500" />
                            ) : event.type === "shift" ? (
                              <Briefcase className="h-3 w-3 text-blue-500" />
                            ) : (
                              <Check className="h-3 w-3 text-purple-500" />
                            )}
                            <div className="truncate">
                              <div className="font-medium">
                                {event.start instanceof Date && !isNaN(event.start.getTime())
                                  ? format(event.start, "h:mm a")
                                  : "Invalid time"}
                              </div>
                              <div className="truncate">{event.name}</div>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center text-xs text-muted-foreground py-2">No events</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="month" className="mt-0">
          <div className="grid grid-cols-7 gap-1">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div key={day} className="text-center p-2 font-medium">
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {monthDays.map((day) => {
              const dayEvents = monthEvents.filter((event) => {
                try {
                  return isSameDay(event.start, day)
                } catch (error) {
                  console.error("Error comparing dates:", error)
                  return false
                }
              })
              const isCurrentDay = isToday(day)
              const isCurrentMonth = isSameMonth(day, date)

              return (
                <div
                  key={day.toISOString()}
                  className={`
                    border rounded-md min-h-[100px] 
                    ${isCurrentDay ? "bg-primary/5 border-primary" : ""}
                    ${!isCurrentMonth ? "bg-gray-50" : ""}
                  `}
                  onClick={() => {
                    setDate(day)
                    setView("day")
                  }}
                >
                  <div
                    className={`
                    text-right p-1 font-medium text-sm
                    ${isCurrentDay ? "text-primary" : ""}
                    ${!isCurrentMonth ? "text-muted-foreground" : ""}
                  `}
                  >
                    {format(day, "d")}
                  </div>
                  <div className="p-1">
                    {/* Conditional rendering: up to three events per cell, with overflow summary below. */}
                    {dayEvents.length > 0
                      ? dayEvents.slice(0, 3).map((event, _idx) => (
                          <div
                            key={`${event.type}-${event.id}`}
                            className={`p-1 mb-1 text-xs rounded-sm border-l-2 ${event.colorClass} truncate`}
                          >
                            <div className="flex items-center gap-1">
                              {event.type === "event" ? (
                                <Calendar className="h-3 w-3 text-green-500" />
                              ) : event.type === "shift" ? (
                                <Briefcase className="h-3 w-3 text-blue-500" />
                              ) : (
                                <Check className="h-3 w-3 text-purple-500" />
                              )}
                              <div className="truncate">{event.name}</div>
                            </div>
                          </div>
                        ))
                      : null}

                    {dayEvents.length > 3 && (
                      <div className="text-xs text-center text-muted-foreground">+{dayEvents.length - 3} more</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="upcoming" className="mt-0">
          <div className="space-y-4">
            {/* Conditional rendering: agenda list when events exist, otherwise empty-state message. */}
            {upcomingEvents.length > 0 ? (
              upcomingEvents.map((event) => (
                <CalendarEvent
                  key={`${event.type}-${event.id}`}
                  event={{
                    ...event,
                    ticketUrl: event.type === "event" ? "https://buytickets.at/theriverside/1550492" : undefined,
                  }}
                  showActions={event.type === "event"}
                  isAdmin={event.id === "p1" || event.id === "p3"} // Just for demo purposes
                />
              ))
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No upcoming events in the next 7 days.</p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
