"use client"

import { useState, useMemo, useEffect } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

const KIND_LABELS: Record<CalendarItemType, string> = {
  event: "Events",
  project: "Projects",
  job: "Jobs",
}

// Filter sentinel for "no narrowing" — kept as a constant so the Select value,
// default state, and reset all reference the same token.
const ALL_FILTER = "all"

interface CalendarItem {
  id: string
  title: string
  date: Date
  type: CalendarItemType
  color: string
  link: string
  time?: string
  location?: string
  /** Owning agent (group) id — drives the per-group filter when the calendar
   *  aggregates items from more than one owner. */
  ownerId?: string
  /** Distinct member ids this item is attributed to (creator + assignees).
   *  Drives the per-member filter; empty when creation persisted no such field. */
  memberIds: string[]
}

interface GroupCalendarProps {
  eventResources: SerializedResource[]
  projectResources: SerializedResource[]
  jobResources: SerializedResource[]
  groupName: string
  /**
   * Server-resolved event start/end ISO timestamps (canonical event-window
   * contract) keyed by event id. Used in preference to raw metadata so calendar
   * placement and times match the event-detail page. Falls back to metadata
   * extraction when an id is absent.
   */
  eventWindows?: Record<string, { start: string; end: string }>
  /**
   * Optional id→display-name maps for the owner-group and member filter labels.
   * The calendar only carries ids on resources, so when a map is absent the
   * filter falls back to a shortened id. Call sites may plumb these in once they
   * aggregate multi-owner data; not required for correctness.
   */
  ownerNames?: Record<string, string>
  memberNames?: Record<string, string>
}

/**
 * Re-expresses a UTC ISO instant as a no-`Z` local wall-clock string
 * (`YYYY-MM-DDTHH:MM:00`). The event-window contract composes times as
 * server-local (UTC) wall-clock; the calendar's grid math reads local
 * date/time getters. Extracting the instant's UTC components (identical on
 * every machine) and rebuilding them as a local string makes `new Date(...)`
 * + local getters/`toLocaleTimeString` recover the organizer's entered
 * wall-clock identically on server and client — TZ-invariant, so there is no
 * hydration drift and no off-by-a-day, and it matches the detail page.
 */
const utcInstantToLocalWallClock = (iso: string): string | null => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`
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

/**
 * Resolves a resource's schedule date the way projects store it: the nested
 * `metadata.timeframe.start` (create form's datetime-range) first, then the
 * legacy flat keys. Returned raw (un-normalized) so callers can decide the
 * createdAt fallback. Shared by the project loop and the job parent-project
 * fallback so both read the identical contract.
 */
const extractScheduleDate = (resource: SerializedResource): string | null => {
  const meta = (resource.metadata ?? {}) as Record<string, unknown>
  const tf = (meta.timeframe ?? {}) as Record<string, unknown>
  const tfStart = typeof tf.start === "string" && tf.start.trim() ? tf.start : null
  return tfStart ?? extractDate(resource, "startDate", "deadline", "date")
}

/**
 * Normalizes an item's attributed member ids from metadata — the creator plus
 * any assignees. Jobs/projects created today persist neither field on the
 * resource (the creator lives on the ledger), so this is usually empty; the
 * member filter self-hides when it can't derive >1 distinct member.
 */
const extractMemberIds = (resource: SerializedResource): string[] => {
  const meta = (resource.metadata ?? {}) as Record<string, unknown>
  const ids = new Set<string>()
  for (const key of ["creatorId", "createdBy", "authorId"]) {
    const value = meta[key]
    if (typeof value === "string" && value.trim()) ids.add(value)
  }
  const assignees = meta.assignees ?? meta.assignedTo
  if (Array.isArray(assignees)) {
    for (const entry of assignees) {
      if (typeof entry === "string" && entry.trim()) {
        ids.add(entry)
      } else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>
        const id = record.agentId ?? record.id ?? record.userId
        if (typeof id === "string" && id.trim()) ids.add(id)
      }
    }
  }
  return Array.from(ids)
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
    ownerId: typeof resource.ownerId === "string" ? resource.ownerId : undefined,
    memberIds: extractMemberIds(resource),
  }
}

// ── Component ──

export function GroupCalendar({
  eventResources,
  projectResources,
  jobResources,
  groupName,
  eventWindows = {},
  ownerNames = {},
  memberNames = {},
}: GroupCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [viewMode, setViewMode] = useState<"month" | "week">("month")
  // "Today" is derived from the client clock/timezone. Computing it during the
  // initial render (server in UTC vs client local) made the today-cell's
  // className diverge between SSR and hydration, throwing React #418. We hold it
  // null until mount so both renders agree (no highlight), then set it client-side.
  const [today, setToday] = useState<Date | null>(null)
  useEffect(() => {
    setToday(new Date())
  }, [])

  // ── Filters (all client-side) ──
  // Kind toggles start all-on; a kind is shown when its flag is true.
  const [kindFilter, setKindFilter] = useState<Record<CalendarItemType, boolean>>({
    event: true,
    project: true,
    job: true,
  })
  const [ownerFilter, setOwnerFilter] = useState<string>(ALL_FILTER)
  const [memberFilter, setMemberFilter] = useState<string>(ALL_FILTER)

  const toggleKind = (kind: CalendarItemType) =>
    setKindFilter((prev) => ({ ...prev, [kind]: !prev[kind] }))

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  // Build calendar items from resources
  const allCalendarItems = useMemo(() => {
    const items: CalendarItem[] = []

    // All calendar dates are normalized to a TZ-invariant local wall-clock so
    // placement and times are identical on server and client (no #418) and never
    // shift a day across timezones, regardless of whether the source is a Z-ISO
    // instant, a server-resolved event window, or a date-only metadata string.
    for (const r of eventResources) {
      // Prefer the server-resolved window (matches the detail page).
      const raw = eventWindows[r.id]?.start ?? extractDate(r, "date", "startDate", "start")
      const dateStr = raw ? utcInstantToLocalWallClock(raw) ?? raw : null
      if (dateStr) items.push(toCalendarItem(r, "event", dateStr, "events"))
    }

    // Index projects by id so jobs can inherit their parent project's schedule
    // date (jobs carry metadata.projectId but persist no date of their own).
    const projectById = new Map<string, SerializedResource>()
    for (const r of projectResources) projectById.set(r.id, r)

    for (const r of projectResources) {
      // Projects store their schedule in metadata.timeframe.{start,end} (the
      // create form's datetime-range) — NOT metadata.startDate. Reading only the
      // flat keys missed it and fell back to createdAt, so every project landed
      // on its creation day in the calendar. Read the nested timeframe.start
      // first, then the legacy flat keys, then createdAt.
      const raw = extractScheduleDate(r) ?? r.createdAt
      const dateStr = utcInstantToLocalWallClock(raw) ?? raw
      if (dateStr) items.push(toCalendarItem(r, "project", dateStr, "projects"))
    }

    for (const r of jobResources) {
      // Jobs have the same class of bug projects had: creation persists no date
      // field on the job resource, so they all stacked on createdAt. Place each
      // job on its REAL date: an explicit job date first (future-proofs if one
      // is ever persisted), then the parent project's schedule date (looked up
      // via metadata.projectId in the same fetched set), and only then createdAt.
      const jmeta = (r.metadata ?? {}) as Record<string, unknown>
      const explicit = extractScheduleDate(r)
      const projectId = typeof jmeta.projectId === "string" ? jmeta.projectId : null
      const parent = projectId ? projectById.get(projectId) : undefined
      const parentDate = parent ? extractScheduleDate(parent) : null
      const raw = explicit ?? parentDate ?? r.createdAt
      const dateStr = utcInstantToLocalWallClock(raw) ?? raw
      if (dateStr) items.push(toCalendarItem(r, "job", dateStr, "jobs"))
    }

    return items
  }, [eventResources, projectResources, jobResources, eventWindows])

  // Distinct owner groups present in the data. The per-group filter only makes
  // sense (and only renders) when the calendar aggregates >1 owner; a single
  // group's own calendar has exactly one owner, so the control stays hidden.
  const ownerOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const item of allCalendarItems) if (item.ownerId) ids.add(item.ownerId)
    return Array.from(ids).map((id) => ({ id, name: ownerNames[id] ?? `${id.slice(0, 8)}…` }))
  }, [allCalendarItems, ownerNames])

  // Distinct attributed members (creators/assignees) across the items. Renders
  // only when >1 distinct member is derivable — otherwise creation persisted no
  // usable attribution and the filter would be a no-op.
  const memberOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const item of allCalendarItems) for (const id of item.memberIds) ids.add(id)
    return Array.from(ids).map((id) => ({ id, name: memberNames[id] ?? `${id.slice(0, 8)}…` }))
  }, [allCalendarItems, memberNames])

  const showOwnerFilter = ownerOptions.length > 1
  const showMemberFilter = memberOptions.length > 1

  // Apply the kind/owner/member filters once; every view (month grid, week,
  // selected-day, stats) derives from this so the controls stay consistent.
  const filteredItems = useMemo(
    () =>
      allCalendarItems.filter((item) => {
        if (!kindFilter[item.type]) return false
        if (showOwnerFilter && ownerFilter !== ALL_FILTER && item.ownerId !== ownerFilter) return false
        if (showMemberFilter && memberFilter !== ALL_FILTER && !item.memberIds.includes(memberFilter)) return false
        return true
      }),
    [allCalendarItems, kindFilter, ownerFilter, memberFilter, showOwnerFilter, showMemberFilter],
  )

  // Calendar grid calculation
  const firstDayOfMonth = new Date(year, month, 1)
  const lastDayOfMonth = new Date(year, month + 1, 0)
  const daysInMonth = lastDayOfMonth.getDate()
  const startingDayOfWeek = firstDayOfMonth.getDay()

  const monthItems = useMemo(
    () => filteredItems.filter((item) => item.date.getFullYear() === year && item.date.getMonth() === month),
    [filteredItems, year, month],
  )

  const selectedDateItems = useMemo(
    () =>
      selectedDate
        ? filteredItems.filter((item) => item.date.toDateString() === selectedDate.toDateString())
        : [],
    [filteredItems, selectedDate],
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
    return filteredItems.filter((item) => item.date >= weekStart && item.date <= weekEnd)
  }, [filteredItems, currentDate])

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
            {/* ── Filters ── */}
            <div className="flex flex-wrap items-center gap-2 mb-4 pb-4 border-b">
              <span className="text-xs font-medium text-muted-foreground mr-1">Show:</span>
              {(Object.keys(KIND_LABELS) as CalendarItemType[]).map((kind) => {
                const active = kindFilter[kind]
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => toggleKind(kind)}
                    aria-pressed={active}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      active
                        ? "bg-muted/50 border-border text-foreground"
                        : "bg-transparent border-dashed border-border text-muted-foreground opacity-60 hover:opacity-100"
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${TYPE_COLORS[kind]} ${active ? "" : "opacity-40"}`} />
                    {KIND_LABELS[kind]}
                  </button>
                )
              })}
              {showOwnerFilter && (
                <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue placeholder="All groups" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>All groups</SelectItem>
                    {ownerOptions.map((owner) => (
                      <SelectItem key={owner.id} value={owner.id}>
                        {owner.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {showMemberFilter && (
                <Select value={memberFilter} onValueChange={setMemberFilter}>
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue placeholder="All members" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>All members</SelectItem>
                    {memberOptions.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
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
                    const isToday = !!today && dayData?.date.toDateString() === today.toDateString()
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
                  const isToday = !!today && day.toDateString() === today.toDateString()
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
