"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Clock } from "lucide-react"

import type { BookingDate, BookingSelection } from "@/lib/booking-slots"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const DEFAULT_START_HOUR = 6
const DEFAULT_END_HOUR = 21
const DEFAULT_INTERVAL_MINUTES = 30
const DEFAULT_BLOCK_MINUTES = 60
const ROW_HEIGHT = 16

function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function startOfWeek(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  next.setDate(next.getDate() - next.getDay())
  return next
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function toMinutes(value: string) {
  const [hoursText, minutesText] = value.split(":")
  const hours = Number.parseInt(hoursText ?? "", 10)
  const minutes = Number.parseInt(minutesText ?? "", 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

function formatSlot(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`
}

function formatTimeLabel(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const suffix = hours >= 12 ? "PM" : "AM"
  const normalized = hours % 12 === 0 ? 12 : hours % 12
  return mins === 0 ? `${normalized}${suffix}` : `${normalized}:${String(mins).padStart(2, "0")}${suffix}`
}

function buildSlot(startMinutes: number, blockMinutes: number) {
  return `${formatSlot(startMinutes)}-${formatSlot(startMinutes + blockMinutes)}`
}

function parseSlot(slot: string) {
  const [startText, endText] = slot.split("-")
  if (!startText || !endText) return null
  const startMinutes = toMinutes(startText)
  const endMinutes = toMinutes(endText)
  if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) return null
  return { startMinutes, endMinutes }
}

function slotCoversMinute(slot: string, minute: number) {
  const parsed = parseSlot(slot)
  return parsed ? minute >= parsed.startMinutes && minute < parsed.endMinutes : false
}

function sortSlots(slots: string[]) {
  return [...slots].sort((left, right) => left.localeCompare(right))
}

interface BookingWeekSchedulerProps {
  bookingDates: BookingDate[]
  onChange?: (next: BookingDate[]) => void
  selection?: BookingSelection | null
  onSelect?: (selection: BookingSelection) => void
  startHour?: number
  endHour?: number
  intervalMinutes?: number
  blockDurationMinutes?: number
  emptyLabel?: string
}

export function BookingWeekScheduler({
  bookingDates,
  onChange,
  selection,
  onSelect,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  blockDurationMinutes = DEFAULT_BLOCK_MINUTES,
  emptyLabel = "No bookable blocks yet in this week.",
}: BookingWeekSchedulerProps) {
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeek(new Date()))

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekAnchor, index)),
    [weekAnchor],
  )

  const startMinutes = startHour * 60
  const endMinutesExclusive = (endHour + 1) * 60
  const safeBlockMinutes = Math.max(blockDurationMinutes, intervalMinutes)

  const timeRows = useMemo(
    () =>
      Array.from(
        { length: Math.max(0, Math.floor((endMinutesExclusive - startMinutes) / intervalMinutes)) },
        (_, index) => startMinutes + index * intervalMinutes,
      ),
    [endMinutesExclusive, intervalMinutes, startMinutes],
  )

  const bookingMap = useMemo(() => {
    const next = new Map<string, string[]>()
    for (const booking of bookingDates) {
      next.set(booking.date, sortSlots(booking.timeSlots))
    }
    return next
  }, [bookingDates])

  const weekSelectionCount = useMemo(
    () =>
      weekDays.reduce((count, day) => {
        const dateKey = formatDateKey(day)
        return count + (bookingMap.get(dateKey)?.length ?? 0)
      }, 0),
    [bookingMap, weekDays],
  )

  const isEditable = typeof onChange === "function"

  const toggleSlot = (date: string, slot: string) => {
    if (!onChange) return

    const next = new Map<string, Set<string>>()
    for (const booking of bookingDates) {
      next.set(booking.date, new Set(booking.timeSlots))
    }

    const slotSet = next.get(date) ?? new Set<string>()
    if (slotSet.has(slot)) {
      slotSet.delete(slot)
    } else {
      slotSet.add(slot)
    }

    if (slotSet.size === 0) {
      next.delete(date)
    } else {
      next.set(date, slotSet)
    }

    onChange(
      Array.from(next.entries())
        .map(([entryDate, slots]) => ({
          date: entryDate,
          timeSlots: sortSlots(Array.from(slots)),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {weekAnchor.toLocaleDateString(undefined, { month: "long", day: "numeric" })} -{" "}
            {addDays(weekAnchor, 6).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
          </p>
          <p className="text-xs text-muted-foreground">
            {isEditable
              ? `Tap a start time to add or remove a ${safeBlockMinutes}-minute bookable block.`
              : `Pick one available ${safeBlockMinutes}-minute booking block to continue.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" onClick={() => setWeekAnchor((current) => addDays(current, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="icon" onClick={() => setWeekAnchor((current) => addDays(current, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card/60 overflow-auto max-h-[360px]">
        <div className="grid min-w-[520px] grid-cols-[52px_repeat(7,minmax(56px,1fr))]">
          <div className="border-b border-r px-1 py-1.5 text-[10px] font-medium text-muted-foreground sticky top-0 bg-card z-10">
            <Clock className="h-3 w-3 mx-auto" />
          </div>
          {weekDays.map((day, index) => {
            const dateKey = formatDateKey(day)
            return (
              <div key={dateKey} className="border-b px-1 py-1.5 text-center sticky top-0 bg-card z-10">
                <div className="text-[10px] font-medium text-muted-foreground">{DAY_LABELS[index]}</div>
                <div className="text-xs font-semibold">{day.getDate()}</div>
              </div>
            )
          })}

          {timeRows.map((rowMinute) => (
            <div key={rowMinute} className="contents">
              <div className="border-r border-t px-1 py-0 text-[9px] text-muted-foreground leading-none flex items-center" style={{ height: ROW_HEIGHT }}>
                {rowMinute % 60 === 0 ? formatTimeLabel(rowMinute) : ""}
              </div>
              {weekDays.map((day) => {
                const dateKey = formatDateKey(day)
                const daySlots = bookingMap.get(dateKey) ?? []
                const candidateSlot = buildSlot(rowMinute, safeBlockMinutes)
                const inBounds = rowMinute + safeBlockMinutes <= endMinutesExclusive
                const available = daySlots.includes(candidateSlot)
                const selected = selection?.date === dateKey && selection?.slot === candidateSlot
                const coveredByAny = daySlots.some((slot) => slotCoversMinute(slot, rowMinute))
                const coveredBySelected = selected || (selection?.date === dateKey && slotCoversMinute(selection.slot, rowMinute))

                return (
                  <button
                    key={`${dateKey}-${rowMinute}`}
                    type="button"
                    disabled={!inBounds}
                    onClick={() => {
                      if (!inBounds) return
                      if (isEditable) {
                        toggleSlot(dateKey, candidateSlot)
                        return
                      }
                      if (available && onSelect) {
                        onSelect({ date: dateKey, slot: candidateSlot })
                      }
                    }}
                    className={cn(
                      "border-t px-0.5 py-0 transition-colors relative",
                      inBounds ? (isEditable || available ? "cursor-pointer" : "cursor-default") : "cursor-not-allowed opacity-30",
                      coveredByAny ? "bg-emerald-500/10" : "bg-transparent",
                      coveredBySelected && "bg-primary/15",
                      !coveredByAny && inBounds && "hover:bg-muted/40",
                    )}
                    style={{ height: ROW_HEIGHT }}
                    aria-pressed={selected || (isEditable && available)}
                    aria-label={`${day.toLocaleDateString()} ${candidateSlot}`}
                  >
                    <div
                      className={cn(
                        "mx-auto rounded-sm",
                        coveredByAny ? "bg-emerald-500/55" : "bg-transparent",
                        coveredBySelected && "bg-primary",
                      )}
                      style={{ height: ROW_HEIGHT - 4, marginTop: 2 }}
                    />
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {weekSelectionCount === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : null}
    </div>
  )
}
