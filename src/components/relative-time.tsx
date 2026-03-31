"use client"

import { useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"

/**
 * Renders a relative timestamp (e.g. "3 minutes ago") that is safe from
 * React hydration mismatches.
 *
 * On the server and during initial client hydration, the component renders an
 * empty string so that server HTML and the first client render always agree.
 * After hydration completes, a `useEffect` fills in the live relative time and
 * keeps it updated every 60 seconds.
 *
 * @param props.date ISO timestamp string or Date object to format.
 * @param props.className Optional CSS class applied to the wrapping `<time>` element.
 * @param props.prefix Optional text prepended before the relative string.
 * @param props.suffix Optional text appended after the relative string (default: none — `addSuffix: true` from date-fns handles "ago").
 */
interface RelativeTimeProps {
  date: string | Date
  className?: string
  prefix?: string
  suffix?: string
}

function formatRelative(date: Date): string {
  return formatDistanceToNow(date, { addSuffix: true })
}

const UPDATE_INTERVAL_MS = 60_000

export function RelativeTime({ date, className, prefix, suffix }: RelativeTimeProps) {
  const [mounted, setMounted] = useState(false)
  const [text, setText] = useState("")

  const dateObj = date instanceof Date ? date : new Date(date)
  const iso = dateObj.toISOString()

  useEffect(() => {
    setMounted(true)
    setText(formatRelative(dateObj))

    const interval = setInterval(() => {
      setText(formatRelative(dateObj))
    }, UPDATE_INTERVAL_MS)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dateObj reference changes every render; iso is the stable identity
  }, [iso])

  // During SSR and first client render, output an empty text node so server
  // and client HTML match exactly.  The `suppressHydrationWarning` on the
  // <time> element is a belt-and-suspenders safeguard in case React compares
  // text content before the effect fires.
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {mounted ? `${prefix ?? ""}${text}${suffix ?? ""}` : ""}
    </time>
  )
}
