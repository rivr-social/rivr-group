"use client"

import type React from "react"

import { useState } from "react"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Calendar, Globe, Edit } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format } from "date-fns"

/**
 * Event summary card used in event listing surfaces (for example feed/grid views).
 *
 * Displays event metadata, optional group link, and action controls such as registration
 * and admin edit shortcuts.
 *
 * Key props:
 * - `event`: event data needed for display and routing
 * - `groupName` / `groupId`: organizer/group display and optional navigation
 * - `onRsvpChange`: RSVP callback for parent-managed state
 * - `isAdmin`: toggles admin-only controls
 */
interface EventCardProps {
  event: {
    id: string
    name: string
    description: string
    location: {
      address: string
    }
    timeframe: {
      start: string
      end: string
    }
    image: string
    price?: number
    ticketsAvailable?: boolean
    type?: string
  }
  groupName: string
  groupId?: string
  creatorName: string
  creatorUsername?: string
  initialRsvpStatus?: "going" | "interested" | "none"
  onRsvpChange?: (status: "going" | "interested" | "none") => void
  linkToEvent?: boolean
  isAdmin?: boolean
}

/**
 * Renders a clickable event card with optional event/group links and admin actions.
 *
 * @param props - Event card display and behavior props.
 * @param props.event - Core event details used for title, timing, image, and routing.
 * @param props.groupName - Organizer/group display name.
 * @param props.groupId - Optional organizer/group id used to link to group page.
 * @param props.creatorName - Creator display name (currently unused in markup).
 * @param props.creatorUsername - Creator username (currently unused in markup).
 * @param props.initialRsvpStatus - Initial RSVP state for local interaction state.
 * @param props.onRsvpChange - Callback fired when RSVP status changes.
 * @param props.linkToEvent - Controls whether card/title click navigates to event details.
 * @param props.isAdmin - Enables admin badge and edit control.
 */
export function EventCard({
  event,
  groupName,
  groupId,
  creatorName,
  creatorUsername,
  initialRsvpStatus = "none",
  onRsvpChange,
  linkToEvent = true,
  isAdmin = false,
}: EventCardProps) {
  // Local RSVP state is initialized from props and tracks optimistic UI selection in this card.
  const [rsvpStatus, setRsvpStatus] = useState(initialRsvpStatus)
  const router = useRouter()
  // Props accepted for API completeness; not rendered in this card variant.
  void creatorName
  void creatorUsername

  // Derive display dates from event timeframe; fall back to current time when missing.
  const eventDate = event.timeframe?.start ? new Date(event.timeframe.start) : new Date()

  // Event handler: toggles RSVP state and notifies parent callback if provided.
  const handleRsvp = (status: "going" | "interested" | "none") => {
    const newStatus = status === rsvpStatus ? "none" : status
    setRsvpStatus(newStatus)
    if (onRsvpChange) {
      onRsvpChange(newStatus)
    }
  }

  // Event handler: card click routes to event details when linking is enabled.
  const handleCardClick = () => {
    if (linkToEvent) {
      // Side effect: client-side navigation to event detail page.
      router.push(`/events/${event.id}`)
    }
  }

  // Event handler: stops bubbling so edit click does not also trigger card navigation.
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Side effect: client-side navigation to event edit page.
    router.push(`/events/${event.id}/edit`)
  }

  return (
    <Card
      className="overflow-hidden border rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer"
      onClick={handleCardClick}
    >
      <div className="relative w-full h-48">
        <Image src={event.image || "/placeholder-event.jpg"} alt={event.name} fill className="object-cover" />
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black/30 to-transparent" />

        <div className="absolute top-2 left-2 bg-card/90 backdrop-blur-sm rounded-md px-2 py-1 flex items-center">
          <Calendar className="h-3 w-3 mr-1 text-primary" />
          <span className="text-xs font-medium">{format(eventDate, "MMM d")}</span>
        </div>

        {isAdmin && (
          <div className="absolute top-2 right-2 bg-primary/90 text-white backdrop-blur-sm rounded-md px-2 py-1 flex items-center">
            <span className="text-xs font-medium">Admin</span>
          </div>
        )}
      </div>

      <CardContent className="p-4">
        <h3 className="text-xl font-bold line-clamp-1">
          {linkToEvent ? (
            <Link href={`/events/${event.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
              {event.name}
            </Link>
          ) : (
            event.name
          )}
        </h3>

        <div className="flex items-center text-sm text-muted-foreground mt-1 mb-2">
          <Calendar className="h-3.5 w-3.5 mr-1" />
          <span>{format(eventDate, "EEE, MMM d · h:mm a")}</span>
        </div>

        <div className="flex items-center text-sm text-muted-foreground mb-3">
          <Globe className="h-3.5 w-3.5 mr-1" />
          <span>{event.location?.address || "Online"}</span>
        </div>

        <div className="mt-2">
          {groupId ? (
            <Link
              href={`/groups/${groupId}`}
              className="text-sm font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {groupName}
            </Link>
          ) : (
            <p className="text-sm font-medium">{groupName}</p>
          )}
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 flex justify-between border-t mt-2 gap-2">
        <Button
          variant={rsvpStatus === "interested" ? "secondary" : "outline"}
          className="flex-1"
          onClick={(e) => {
            e.stopPropagation()
            handleRsvp("interested")
          }}
        >
          {rsvpStatus === "interested" ? "Interested" : "Interested"}
        </Button>
        <Button
          className={`flex-1 ${rsvpStatus === "going" ? "bg-primary hover:bg-primary/90" : "bg-primary hover:bg-primary/90"}`}
          onClick={(e) => {
            e.stopPropagation()
            handleRsvp("going")
          }}
        >
          {rsvpStatus === "going" ? "Going" : "Register"}
        </Button>

        {/* Conditional rendering: show edit control only for event admins. */}
        {isAdmin && (
          <Button variant="outline" className="flex-none" onClick={handleEditClick}>
            <Edit className="h-4 w-4" />
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
