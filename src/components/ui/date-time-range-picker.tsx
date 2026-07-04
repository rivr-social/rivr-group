"use client";

/**
 * DateTimeRangePicker — one start→end date+time picker used across all
 * create/edit surfaces (projects, events, …), replacing the ad-hoc pairs of
 * native `<input type="date">` + `<input type="time">` fields.
 *
 * Layout (reference design 2026-07-04): two stacked endpoint rows — Starts and
 * Ends, each "date | time" — above a SINGLE month calendar. The active endpoint
 * row is highlighted; tapping a calendar day sets that endpoint (start auto-
 * advances to end). The header carries the month label with Now + prev/next
 * controls. Values are the `datetime-local` string shape ("YYYY-MM-DDTHH:mm")
 * so it drops into existing state/actions without conversion. End is clamped
 * to be >= start.
 *
 * Controlled: pass `start`/`end` (either may be `""`) and an `onChange(start, end)`.
 */

import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { addMonths, format, startOfMonth } from "date-fns";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Value helpers — work in the `datetime-local` string shape "YYYY-MM-DDTHH:mm".
// ---------------------------------------------------------------------------

const DEFAULT_START_TIME = "09:00";
const DEFAULT_END_TIME = "10:00";

/** Split a datetime-local string into a local Date (midnight) + "HH:mm". */
function splitValue(value: string): { date: Date | undefined; time: string } {
  if (!value) return { date: undefined, time: "" };
  const [datePart, timePart = ""] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return { date: undefined, time: timePart.slice(0, 5) };
  return { date: new Date(y, m - 1, d), time: timePart.slice(0, 5) };
}

/** Compose a local Date + "HH:mm" back into "YYYY-MM-DDTHH:mm". */
function composeValue(date: Date | undefined, time: string): string {
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hhmm = /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_START_TIME;
  return `${yyyy}-${mm}-${dd}T${hhmm}`;
}

function nowValue(): string {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return composeValue(now, hhmm);
}

function formatDisplay(value: string): string | null {
  const { date, time } = splitValue(value);
  if (!date) return null;
  const withTime = time ? new Date(`${value}`) : date;
  return format(withTime, time ? "MMM d, yyyy · h:mm a" : "MMM d, yyyy");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DateTimeRangePickerProps {
  /** Start value, "YYYY-MM-DDTHH:mm" or "". */
  start: string;
  /** End value, "YYYY-MM-DDTHH:mm" or "". */
  end: string;
  onChange: (start: string, end: string) => void;
  startLabel?: string;
  endLabel?: string;
  placeholder?: string;
  /** Disable dates before today. */
  disablePast?: boolean;
  id?: string;
  className?: string;
}

interface EndpointRowProps {
  label: string;
  value: string;
  active: boolean;
  onActivate: () => void;
  onTimeChange: (time: string) => void;
}

/** One "date | time" endpoint row (Starts / Ends). */
function EndpointRow({ label, value, active, onActivate, onTimeChange }: EndpointRowProps) {
  const { date, time } = splitValue(value);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={active}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-center overflow-hidden rounded-xl border bg-muted/50 text-left transition-colors",
        active
          ? "border-[hsl(var(--background))] ring-2 ring-[hsl(var(--background)/0.35)] dark:border-primary dark:ring-primary/30"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      <span
        className={cn(
          "flex-1 truncate px-3 py-2 text-sm font-medium",
          !date && "font-normal text-muted-foreground",
        )}
      >
        {date ? format(date, "MMM d, yyyy") : `Pick ${label.toLowerCase()} date`}
      </span>
      <span className="h-6 w-px shrink-0 bg-border" aria-hidden />
      <input
        type="time"
        aria-label={`${label} time`}
        value={time}
        onClick={(e) => {
          e.stopPropagation();
          onActivate();
        }}
        onChange={(e) => onTimeChange(e.target.value)}
        className="w-[104px] shrink-0 bg-transparent px-3 py-2 text-right text-sm font-medium tabular-nums text-foreground focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden"
      />
    </div>
  );
}

export function DateTimeRangePicker({
  start,
  end,
  onChange,
  startLabel = "Starts",
  endLabel = "Ends",
  placeholder = "Select a date & time range",
  disablePast = false,
  id,
  className,
}: DateTimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<"start" | "end">("start");
  const [month, setMonth] = useState<Date>(() => splitValue(start).date ?? new Date());

  const startParts = useMemo(() => splitValue(start), [start]);
  const endParts = useMemo(() => splitValue(end), [end]);

  const range: DateRange | undefined = startParts.date
    ? { from: startParts.date, to: endParts.date }
    : undefined;

  const handleDayClick = (day: Date) => {
    if (activeField === "start") {
      const nextStart = composeValue(day, startParts.time || DEFAULT_START_TIME);
      // Keep end >= start; if the new start passes the current end, drag end along.
      const nextEnd =
        end && end >= nextStart
          ? end
          : composeValue(day, endParts.time || DEFAULT_END_TIME);
      onChange(nextStart, nextEnd);
      setActiveField("end");
      return;
    }
    const nextEnd = composeValue(day, endParts.time || DEFAULT_END_TIME);
    if (start && nextEnd < start) {
      // Picking an end before the start restarts the range from that day.
      onChange(composeValue(day, startParts.time || DEFAULT_START_TIME), nextEnd);
      return;
    }
    onChange(start || composeValue(day, DEFAULT_START_TIME), nextEnd);
  };

  const emitStartTime = (time: string) => {
    onChange(composeValue(startParts.date, time), end);
  };

  const emitEndTime = (time: string) => {
    // Clamp: if end lands before start on the same/earlier day, pull end up.
    const nextEnd = composeValue(endParts.date ?? startParts.date, time);
    if (start && nextEnd && nextEnd < start) {
      onChange(start, start);
      return;
    }
    onChange(start, nextEnd);
  };

  const handleNow = () => {
    // Set ONLY the active endpoint to now; nudge the other endpoint just enough
    // to keep start <= end. Focus stays on the active field.
    const value = nowValue();
    if (activeField === "start") {
      onChange(value, end && end >= value ? end : value);
    } else {
      onChange(start && start <= value ? start : value, value);
    }
    setMonth(startOfMonth(new Date()));
  };

  // Replaces react-day-picker's own nav: Now + prev/next on the controlled month.
  const PickerNav = () => (
    <div className="absolute right-1 top-0 z-10 flex h-8 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-sm font-normal text-muted-foreground hover:text-foreground"
        onClick={handleNow}
      >
        Now
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Previous month"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => setMonth((m) => addMonths(m, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Next month"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => setMonth((m) => addMonths(m, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  const label = (() => {
    const s = formatDisplay(start);
    const e = formatDisplay(end);
    if (!s) return placeholder;
    if (!e || e === s) return s;
    return `${s} → ${e}`;
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !start && "text-muted-foreground",
            className,
          )}
        >
          <CalendarClock className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-3 backdrop-blur-xl"
        align="start"
        collisionPadding={12}
        // `.liquid-glass` paints `background: var(--glass-surface-bg)` which
        // overrides any Tailwind bg-* class (F6 lesson) — set the var instead.
        style={{ ["--glass-surface-bg" as string]: "hsl(var(--popover) / 0.97)" }}
      >
        <div className="w-[286px] space-y-2">
          <EndpointRow
            label={startLabel}
            value={start}
            active={activeField === "start"}
            onActivate={() => setActiveField("start")}
            onTimeChange={emitStartTime}
          />
          <EndpointRow
            label={endLabel}
            value={end}
            active={activeField === "end"}
            onActivate={() => setActiveField("end")}
            onTimeChange={emitEndTime}
          />
          <Calendar
            // Remount on any value change: rdp v9 left a stale range highlight
            // after programmatic (Now) updates; keying by value forces re-sync.
            key={`${start}|${end}`}
            mode="range"
            numberOfMonths={1}
            month={month}
            onMonthChange={setMonth}
            selected={range}
            onDayClick={handleDayClick}
            disabled={
              disablePast
                ? { before: new Date(new Date().setHours(0, 0, 0, 0)) }
                : undefined
            }
            components={{ Nav: PickerNav } as Record<string, unknown>}
            className="p-0 pt-1"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default DateTimeRangePicker;
