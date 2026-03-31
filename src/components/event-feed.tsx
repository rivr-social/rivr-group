"use client"

import { useMemo } from "react"
import { EventCard } from "@/components/event-card"
import { EmptyState } from "@/components/empty-state"
import { LoadingSpinner } from "@/components/loading-spinner"
import { useAppContext } from "@/contexts/app-context"

/**
 * Event feed grid for the Events discovery/listing experience.
 *
 * Used in pages or sections that display a searchable/filterable collection of events,
 * with chapter-level filtering and RSVP status wiring per event card.
 *
 * Key props:
 * - `events`: source events to render
 * - `query`: text query used for client-side filtering
 * - `chapterId`: selected chapter override (falls back to app context selection)
 * - `onRsvpChange`: callback invoked when an event card RSVP changes
 */
interface EventFeedProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events?: any[]
  query?: string
  chapterId?: string
  loading?: boolean
  getGroupName?: (groupId: string) => string
  getGroupId?: (groupId: string) => string
  getCreatorName?: (creatorId: string) => string
  getCreatorUsername?: (creatorId: string) => string
  onRsvpChange?: (eventId: string, status: "going" | "interested" | "none") => void
  isEventAdmin?: (eventId: string) => boolean
  initialRsvpStatuses?: Record<string, "going" | "interested" | "none">
}

// Default helper functions
const defaultGetGroupName = (groupId: string): string => {
  return groupId || "Unknown Group"
}

const defaultGetGroupId = (groupId: string): string => {
  return groupId
}

const defaultGetCreatorName = (creatorId: string): string => {
  return creatorId || "Unknown Creator"
}

const defaultGetCreatorUsername = (creatorId: string): string => {
  return creatorId || "unknown"
}

/**
 * Renders a responsive event card grid with loading and empty states.
 *
 * @param props - Event feed configuration and callbacks.
 * @param props.events - Event list supplied by parent data layer.
 * @param props.query - Optional search term for event name/description filtering.
 * @param props.chapterId - Optional chapter filter override.
 * @param props.loading - Whether to render the loading spinner.
 * @param props.getGroupName - Maps organizer/group id to display name.
 * @param props.getGroupId - Maps organizer/group id to canonical group id.
 * @param props.getCreatorName - Maps creator id to display name.
 * @param props.getCreatorUsername - Maps creator id to username.
 * @param props.onRsvpChange - Parent callback for RSVP status changes.
 * @param props.isEventAdmin - Determines whether current user is admin for each event.
 * @param props.initialRsvpStatuses - Initial RSVP statuses keyed by event id.
 */
export function EventFeed({
  events: propEvents,
  query,
  chapterId,
  loading = false,
  getGroupName = defaultGetGroupName,
  getGroupId = defaultGetGroupId,
  getCreatorName = defaultGetCreatorName,
  getCreatorUsername = defaultGetCreatorUsername,
  onRsvpChange,
  isEventAdmin,
  initialRsvpStatuses = {},
}: EventFeedProps) {
  const { state } = useAppContext()

  // Resolve active chapter from explicit prop first, then fall back to app-level chapter state.
  const activeChapterId = chapterId || state.selectedChapter

  // Memoize derived event list so filtering only recomputes when source inputs change.
  const events = useMemo(() => {
    let filteredEvents = propEvents ? [...propEvents] : []

    // Apply chapter filtering when a specific chapter is selected.
    if (activeChapterId && activeChapterId !== "all") {
      filteredEvents = filteredEvents.filter(
        (event) => event.chapterTags && event.chapterTags.includes(activeChapterId),
      )
    }

    // Apply text filtering against event name and description.
    if (query) {
      const lowerQuery = query.toLowerCase()
      filteredEvents = filteredEvents.filter(
        (event) =>
          event.name.toLowerCase().includes(lowerQuery) ||
          (event.description && event.description.toLowerCase().includes(lowerQuery)),
      )
    }

    return filteredEvents
  }, [propEvents, query, activeChapterId])

  const isLoading = loading

  // Forward RSVP changes upward so parent state/store can persist and synchronize the update.
  const handleRsvpChange = (eventId: string, status: "going" | "interested" | "none") => {
    if (onRsvpChange) {
      onRsvpChange(eventId, status)
    }
  }

  // Conditional rendering: show spinner while parent data is loading.
  if (isLoading) {
    return <LoadingSpinner />
  }

  // Conditional rendering: show empty state when no events match active filters.
  if (events.length === 0) {
    return (
      <EmptyState
        title="No events found"
        description={
          activeChapterId !== "all"
            ? `There are no events in this chapter. Try selecting a different chapter.`
            : `There are no events matching your criteria.`
        }
        icon="calendar"
      />
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {events.map((event) => {
        // Normalize creator identity from possible source fields before passing to card helpers.
        const creatorId =
          (typeof event.creator === "string" && event.creator) ||
          (typeof event.organizer === "string" && event.organizer) ||
          ""
        return (
          <EventCard
            key={event.id}
            event={{
              id: event.id,
              name: event.name,
              description: event.description,
              location: event.location,
              timeframe: event.timeframe,
              image: event.image,
              price: event.price || 0,
              ticketsAvailable: event.price > 0,
            }}
            groupName={getGroupName(event.organizer || "")}
            groupId={getGroupId ? getGroupId(event.organizer || "") : undefined}
            creatorName={getCreatorName(creatorId)}
            creatorUsername={getCreatorUsername ? getCreatorUsername(creatorId) : undefined}
            initialRsvpStatus={initialRsvpStatuses[event.id] || "none"}
            onRsvpChange={(status) => handleRsvpChange(event.id, status)}
            isAdmin={isEventAdmin ? isEventAdmin(event.id) : false}
          />
        )
      })}
    </div>
  )
}
