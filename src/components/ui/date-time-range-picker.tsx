"use client";

/**
 * DateTimeRangePicker — one polished start→end date+time picker used across all
 * create/edit surfaces (projects, events, …), replacing the ad-hoc pairs of
 * native `<input type="date">` + `<input type="time">` fields.
 *
 * A single trigger button shows the formatted range and opens a popover with a
 * two-month range calendar plus a start time and an end time. Values are the
 * `datetime-local` string shape (`"YYYY-MM-DDTHH:mm"`) so it drops into existing
 * state/actions without conversion. End is clamped to be >= start.
 *
 * Controlled: pass `start`/`end` (either may be `""`) and an `onChange(start, end)`.
 */

import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { CalendarClock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  const startParts = useMemo(() => splitValue(start), [start]);
  const endParts = useMemo(() => splitValue(end), [end]);

  const range: DateRange | undefined = startParts.date
    ? { from: startParts.date, to: endParts.date }
    : undefined;

  const emitRange = (nextRange: DateRange | undefined) => {
    const from = nextRange?.from;
    const to = nextRange?.to;
    const nextStart = composeValue(from, startParts.time || DEFAULT_START_TIME);
    // Default the end to the start day when only one day is picked.
    const nextEnd = composeValue(to ?? from, endParts.time || DEFAULT_END_TIME);
    onChange(nextStart, nextEnd);
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
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={range}
          defaultMonth={startParts.date}
          onSelect={emitRange}
          disabled={disablePast ? { before: new Date(new Date().setHours(0, 0, 0, 0)) } : undefined}
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3 border-t p-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{startLabel}</Label>
            <Input
              type="time"
              value={startParts.time}
              onChange={(e) => emitStartTime(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{endLabel}</Label>
            <Input
              type="time"
              value={endParts.time}
              onChange={(e) => emitEndTime(e.target.value)}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default DateTimeRangePicker;
