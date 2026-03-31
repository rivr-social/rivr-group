"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Calendar, Clock, MapPin, Check, Briefcase, Users, Pencil, Ticket, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getEntityBadgeClass } from "@/lib/entity-style"
import Link from "next/link"
import { format } from "date-fns"
import { useRouter } from "next/navigation"
import { cancelEventAction } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"

/**
 * Calendar event card used in calendar/list schedule views.
 *
 * Supports compact and full layouts, RSVP controls, admin actions, and optional ticket CTAs
 * for event-type entries in scheduling features.
 *
 * Key props:
 * - `event`: normalized calendar item data (timing, type, display metadata)
 * - `onRsvp`: callback for RSVP changes
 * - `showActions`: toggles RSVP action footer for event items
 * - `compact`: switches between condensed and full card rendering
 * - `isAdmin`: enables admin-only management controls
 */
interface CalendarEventProps {
  event: {
    id: string
    name: string
    projectName?: string
    projectId?: string
    groupName?: string
    groupId?: string
    start: Date
    end: Date
    location?: string
    type: string
    color?: string
    colorClass?: string
    ticketUrl?: string
    price?: number
    ticketsAvailable?: boolean
  }
  onRsvp?: (eventId: string, status: "going" | "interested" | "none") => void
  initialRsvpStatus?: "going" | "interested" | "none"
  showActions?: boolean
  linkToEvent?: boolean
  compact?: boolean
  isAdmin?: boolean
}

/**
 * Renders a calendar item card with optional compact mode, RSVP actions, tickets, and admin controls.
 *
 * @param props - Calendar event display and interaction configuration.
 * @param props.event - Event/shift/task data used for rendering content and links.
 * @param props.onRsvp - Callback fired when RSVP status changes.
 * @param props.initialRsvpStatus - Initial RSVP state for local selection UI.
 * @param props.showActions - Enables RSVP/ticket action footer for event entries.
 * @param props.linkToEvent - Controls whether titles route to detail pages.
 * @param props.compact - Switches to condensed list item presentation.
 * @param props.isAdmin - Enables admin management controls section.
 */
export function CalendarEvent({
  event,
  onRsvp,
  initialRsvpStatus = "none",
  showActions = false,
  linkToEvent = true,
  compact = false,
  isAdmin = false,
}: CalendarEventProps) {
  // Local RSVP state keeps UI selection in sync for action buttons.
  const [rsvpStatus, setRsvpStatus] = useState(initialRsvpStatus)
  const router = useRouter()
  const [isCancelling, startCancelTransition] = useTransition()
  const { toast } = useToast()

  // Validate and normalize start time for safe formatting/rendering.
  const startDate = event.start instanceof Date && !isNaN(event.start.getTime()) ? event.start : new Date()

  // Validate and normalize end time, defaulting to one hour after start when invalid/missing.
  const endDate =
    event.end instanceof Date && !isNaN(event.end.getTime())
      ? event.end
      : new Date(startDate.getTime() + 60 * 60 * 1000) // Default to 1 hour after start

  const formatTime = (date: Date) => {
    try {
      return format(date, "h:mm a")
    } catch (error) {
      console.error("Error formatting date:", error)
      return "Invalid time"
    }
  }

  // Helper computes human-readable duration between start and end timestamps.
  const getDuration = (start: Date, end: Date) => {
    try {
      if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
        return ""
      }
      const durationMs = end.getTime() - start.getTime()
      const hours = Math.floor(durationMs / (1000 * 60 * 60))
      const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60))

      return `${hours > 0 ? `${hours}h ` : ""}${minutes > 0 ? `${minutes}m` : ""}`
    } catch (error) {
      console.error("Error calculating duration:", error)
      return ""
    }
  }

  // Event handler: toggles RSVP choice and forwards updates to parent state/store callback.
  const handleRsvp = (status: "going" | "interested" | "none") => {
    const newStatus = status === rsvpStatus ? "none" : status
    setRsvpStatus(newStatus)

    if (onRsvp) {
      onRsvp(event.id, newStatus)
    }
  }

  // Select icon by event type so mixed calendar entities are visually distinguishable.
  const getEventIcon = () => {
    switch (event.type) {
      case "shift":
        return <Briefcase className="h-6 w-6" />
      case "event":
        return <Calendar className="h-6 w-6" />
      case "task":
        return <Check className="h-6 w-6" />
      default:
        return <Calendar className="h-6 w-6" />
      }
  }

  // Select icon chip styling by event type using centralized badge classes.
  const getEventIconBackground = () => {
    return getEntityBadgeClass(event.type)
  }

  // Route helper maps each calendar entity type to its canonical detail page.
  const getEventLink = () => {
    switch (event.type) {
      case "shift":
        return `/jobs/${event.id}`
      case "event":
        return `/events/${event.id}`
      case "task":
        return `/jobs/${event.id}`
      default:
        return `#`
      }
  }

  // Resolve color class used for visual accenting in compact/full layouts.
  const getEventColor = () => {
    if (event.colorClass) return event.colorClass
    return "border-gray-300 bg-gray-50"
  }

  // Determine whether ticket purchase actions should be shown.
  const hasTickets = event.ticketsAvailable !== false && event.price !== undefined && event.price > 0

  // Conditional rendering: compact branch for dense calendar/list displays.
  if (compact) {
    return (
      <div className={`p-2 rounded-md border-l-4 ${getEventColor()} mb-2`}>
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            <div className={`rounded-full p-1.5 ${getEventIconBackground()}`}>{getEventIcon()}</div>
            <div>
              <h3 className="font-medium text-sm">
                {linkToEvent ? (
                  <Link href={getEventLink()} className="hover:underline">
                    {event.name}
                  </Link>
                ) : (
                  event.name
                )}
              </h3>
              <div className="text-xs text-muted-foreground">
                {formatTime(startDate)} - {formatTime(endDate)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {hasTickets && (
              <Badge variant="outline" className="text-xs bg-green-50 border-green-200 text-green-700">
                ${event.price?.toFixed(2)}
              </Badge>
            )}
            <Badge variant="outline" className="capitalize text-xs">
              {event.type}
            </Badge>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Card className={cn("border shadow-sm overflow-hidden", event.colorClass ? `border-l-4 ${event.colorClass}` : "")}>
      <CardContent className="p-4">
        <div className="flex items-start gap-4 mb-4">
          <div className={`rounded-full p-3 ${getEventIconBackground()} self-start`}>{getEventIcon()}</div>

          <div className="flex-1">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-medium text-lg">
                  {linkToEvent ? (
                    <Link href={getEventLink()} className="hover:underline">
                      {event.name}
                    </Link>
                  ) : (
                    event.name
                  )}
                </h3>
                {event.projectName && (
                  event.projectId ? (
                    <Link href={`/groups/${event.projectId}`} className="text-sm text-muted-foreground hover:underline">
                      {event.projectName}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">{event.projectName}</span>
                  )
                )}
                {event.groupName && !event.projectName && (
                  event.groupId ? (
                    <Link href={`/groups/${event.groupId}`} className="text-sm text-muted-foreground hover:underline">
                      {event.groupName}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">{event.groupName}</span>
                  )
                )}
              </div>
              <div className="flex items-center gap-2">
                {hasTickets && (
                  <Badge variant="outline" className="bg-green-50 border-green-200 text-green-700">
                    ${event.price?.toFixed(2)}
                  </Badge>
                )}
                <Badge variant="outline" className="capitalize">
                  {event.type}
                </Badge>
              </div>
            </div>

            <div className="space-y-2 text-sm mt-3">
              <div className="flex items-center">
                <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
                <span>{format(startDate, "EEEE, MMMM d, yyyy")}</span>
              </div>
              <div className="flex items-center">
                <Clock className="h-4 w-4 mr-2 text-muted-foreground" />
                <span>
                  {formatTime(startDate)} - {formatTime(endDate)} ({getDuration(startDate, endDate)})
                </span>
              </div>
              {event.location && (
                <div className="flex items-center">
                  <MapPin className="h-4 w-4 mr-2 text-muted-foreground" />
                  <span>{event.location}</span>
                </div>
              )}
              {event.groupName && event.projectName && (
                <div className="flex items-center">
                  <Users className="h-4 w-4 mr-2 text-muted-foreground" />
                  <span>{event.groupName}</span>
                </div>
              )}
            </div>

            {/* Conditional rendering: ticket CTA appears only when paid tickets are available. */}
            {hasTickets && (
              <div className="mt-4">
                <Button
                  className="w-full py-2 text-base font-medium bg-green-600 hover:bg-green-700 text-white"
                  onClick={(e) => {
                    e.stopPropagation()
                    // Side effect: client-side navigation to event ticket purchase page.
                    router.push(`/events/${event.id}/tickets`)
                  }}
                >
                  <Ticket className="h-4 w-4 mr-2" />
                  Buy Tickets
                </Button>
              </div>
            )}

            {/* Conditional rendering: admin-only event management controls. */}
            {isAdmin && (
              <div className="mt-4 p-3 border rounded-md bg-gray-50">
                <h4 className="font-medium mb-2">Admin Controls</h4>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Side effect: client-side navigation to event edit page.
                      router.push(`/events/${event.id}/edit`)
                    }}
                  >
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit Event
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Side effect: client-side navigation to attendee management page.
                      router.push(`/events/${event.id}/registered`)
                    }}
                  >
                    <Users className="h-4 w-4 mr-2" />
                    Manage Attendees
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Side effect: client-side navigation to ticket management page.
                      router.push(`/events/${event.id}/tickets`)
                    }}
                  >
                    <Ticket className="h-4 w-4 mr-2" />
                    Manage Tickets
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                    disabled={isCancelling}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm("Are you sure you want to cancel this event?")) {
                        startCancelTransition(async () => {
                          const result = await cancelEventAction(event.id)
                          if (result.success) {
                            toast({
                              title: "Event cancelled",
                              description: result.message,
                            })
                          } else {
                            toast({
                              title: "Failed to cancel event",
                              description: result.message,
                              variant: "destructive",
                            })
                          }
                        })
                      }
                    }}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Cancel Event
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {/* Conditional rendering: RSVP footer is only shown for event items when actions are enabled. */}
      {showActions && event.type === "event" && (
        <CardFooter className="p-4 pt-0 flex justify-between gap-2 border-t mt-2">
          <Button
            size="sm"
            variant={rsvpStatus === "interested" ? "default" : "outline"}
            className={rsvpStatus === "interested" ? "bg-primary" : ""}
            onClick={() => handleRsvp("interested")}
          >
            {rsvpStatus === "interested" && <Check className="h-4 w-4 mr-1" />}
            Interested
          </Button>
          <Button
            size="sm"
            variant={rsvpStatus === "going" ? "default" : "outline"}
            className={rsvpStatus === "going" ? "bg-primary" : ""}
            onClick={() => handleRsvp("going")}
          >
            {rsvpStatus === "going" && <Check className="h-4 w-4 mr-1" />}
            Going
          </Button>
          {hasTickets ? (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={(e) => {
                e.stopPropagation()
                // Side effect: client-side navigation to ticket purchase flow.
                router.push(`/events/${event.id}/tickets`)
              }}
            >
              <Ticket className="h-4 w-4 mr-1" />
              Tickets
            </Button>
          ) : (
            <Button size="sm" variant="default" onClick={() => handleRsvp("going")}>
              RSVP
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
