import Link from "next/link"
import Image from "next/image"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { Calendar, MapPin, Users, Video, Ticket } from "lucide-react"
import { fetchEventDetail, fetchAgent } from "@/app/actions/graph"
import { fetchEventRsvpCount, fetchEventAttendees } from "@/app/actions/interactions"
import { agentToEvent } from "@/lib/graph-adapters"
import { buildResourcePageMetadata } from "@/lib/object-metadata"
import { getEventTranscriptDocument } from "@/lib/queries/resources"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { EventDetailActions } from "@/components/event-detail-actions"
import { EventTranscriptPanel } from "@/components/event-transcript-panel"
import { EventToolbar } from "@/components/event-toolbar"
import { EventDetailTabs } from "@/components/event-detail-tabs"
import { buildEventStructuredData, serializeJsonLd } from "@/lib/structured-data"
import { isTranscriptionConfigured } from "@/lib/transcription"

/**
 * Event detail page with a two-column layout matching the demo design.
 *
 * Route: `/events/[id]`
 * Rendering: Server Component -- data fetched on the server; interactive
 *   sections delegate to client components (EventDetailActions, EventToolbar,
 *   EventDetailTabs).
 *
 * Layout:
 *   Left column (350px):  Event image, Presented by, Hosted by, Attendees,
 *                          Contact/Report, Tags.
 *   Right column (flex-1): Title/date/location header, Registration section,
 *                           Tabbed content (About, Attendees, Discussion, Updates).
 */

/** Placeholder image used when the event has no image set. */
const EVENT_PLACEHOLDER_IMAGE = "/placeholder-event.jpg"

/** Placeholder image used when a user/organizer has no avatar set. */
const AVATAR_PLACEHOLDER_IMAGE = "/placeholder-user.jpg"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const agent = await fetchEventDetail(id)

  if (!agent) {
    return {
      title: "Event Not Found | RIVR",
    }
  }

  return buildResourcePageMetadata(
    {
      id: agent.id,
      ownerId: "",
      name: agent.name,
      type: "event",
      description: agent.description,
      content: null,
      url: null,
      metadata: agent.metadata ?? {},
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      isPublic: agent.visibility === "public",
      visibility: agent.visibility,
      tags: [],
    },
    `/events/${agent.id}`,
  )
}

/**
 * Formats a numeric price as a USD currency string.
 *
 * @param price - Numeric price value.
 * @returns Locale-formatted currency string (e.g., "$25.00").
 */
function formatCurrency(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(price)
}

/**
 * Formats a Date into a human-readable day string (e.g., "Wednesday, March 5").
 *
 * @param date - Date object to format.
 * @returns Formatted date string with weekday and month/day.
 */
function formatDayString(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
}

/**
 * Formats a Date into a time string (e.g., "2:00 PM").
 *
 * @param date - Date object to format.
 * @returns Formatted time string with hour and minute.
 */
function formatTimeString(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

/**
 * Extracts initials (first two characters) from a name string for avatar fallbacks.
 *
 * @param name - Full name or display name.
 * @returns First two characters uppercased.
 */
function getInitials(name: string): string {
  return name.substring(0, 2).toUpperCase()
}

/**
 * Renders the primary event detail view in a two-column layout.
 *
 * Fetches event data, organizer/creator profiles, and RSVP count on the server,
 * then renders the layout with client component islands for interactive features.
 *
 * @param props - Async route params containing the event id.
 * @returns The event detail UI or a 404 response when the event does not exist.
 */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Fetch event data on the server before rendering the page.
  const agent = await fetchEventDetail(id)

  if (!agent) {
    notFound()
  }

  // Normalize graph data into the UI event shape.
  const event = agentToEvent(agent)

  // Owner id for downstream permission checks in client action components.
  const ownerId = typeof agent.metadata?.creatorId === "string" ? agent.metadata.creatorId : undefined

  const start = new Date(event.timeframe.start)
  const end = new Date(event.timeframe.end)

  // Resolve location display values from the event data.
  const locationName = typeof event.location === "object" && event.location
    ? event.location.name || event.location.address || ""
    : ""
  const locationIsVirtual = !locationName || locationName.toLowerCase().includes("zoom") || locationName.toLowerCase().includes("virtual") || locationName.toLowerCase().includes("online")

  const ticketPrice = Number(event.price ?? 0)
  const showTickets = Number.isFinite(ticketPrice) && ticketPrice > 0

  // Fetch RSVP count, organizer, and creator data in parallel.
  const organizerId = event.organizer || ""
  const creatorId = event.creator || ""

  const [rsvpCount, attendees, organizer, creator, transcriptDocument] = await Promise.all([
    fetchEventRsvpCount(id),
    fetchEventAttendees(id),
    organizerId ? fetchAgent(organizerId).catch(() => null) : Promise.resolve(null),
    creatorId && creatorId !== organizerId
      ? fetchAgent(creatorId).catch(() => null)
      : Promise.resolve(null),
    getEventTranscriptDocument(id),
  ])

  // When creator and organizer are the same person, reuse the organizer fetch.
  const resolvedCreator = creatorId === organizerId ? organizer : creator
  const structuredData = buildEventStructuredData(event, {
    visibility: agent.visibility ?? null,
    organizerName: organizer?.name ?? undefined,
  })
  const eventGroupId = typeof agent.metadata?.groupId === "string" ? agent.metadata.groupId : null
  const transcriptionEnabled =
    eventGroupId != null && (((agent.metadata ?? {}) as Record<string, unknown>).transcriptionEnabled === true || isTranscriptionConfigured())

  return (
    <div className="min-h-screen w-full flex flex-col items-center py-8 px-4">
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        />
      ) : null}
      {/* Main content container -- two-column layout on desktop */}
      <div className="w-full max-w-6xl flex flex-col md:flex-row gap-8">

        {/* ================================================================
            LEFT COLUMN - Event image, organizer, host, attendees, tags
            ================================================================ */}
        <div className="w-full md:w-[350px] flex-shrink-0 flex flex-col gap-4">

          {/* Event image */}
          <div className="relative w-full aspect-square overflow-hidden rounded-lg">
            <Image
              src={event.image || EVENT_PLACEHOLDER_IMAGE}
              alt={event.name}
              fill
              className="object-cover"
              priority
            />
          </div>

          {/* Presented by (organizer group/org) */}
          {organizer ? (
            <div className="bg-background rounded-lg border p-4">
              <p className="text-sm text-muted-foreground mb-2">Presented by</p>
              <Link
                href={`/profile/${organizer.metadata?.username || organizer.id}`}
                className="flex items-center gap-3 hover:opacity-80"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage
                    src={organizer.image || AVATAR_PLACEHOLDER_IMAGE}
                    alt={organizer.name}
                  />
                  <AvatarFallback>{getInitials(organizer.name)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{organizer.name}</span>
              </Link>
              {event.description ? (
                <p className="text-sm text-muted-foreground mt-3">
                  {event.description.substring(0, 100)}
                  {event.description.length > 100 ? "..." : ""}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Hosted by (event creator) */}
          {resolvedCreator ? (
            <div className="bg-background rounded-lg border p-4">
              <p className="text-sm text-muted-foreground mb-2">Hosted By</p>
              <Link
                href={`/profile/${resolvedCreator.metadata?.username || resolvedCreator.id}`}
                className="flex items-center gap-3 hover:opacity-80"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage
                    src={resolvedCreator.image || AVATAR_PLACEHOLDER_IMAGE}
                    alt={resolvedCreator.name}
                  />
                  <AvatarFallback>{getInitials(resolvedCreator.name)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{resolvedCreator.name}</span>
              </Link>
            </div>
          ) : null}

          {/* Attendees summary */}
          <div className="bg-background rounded-lg border p-4">
            <p className="font-medium mb-2">
              <Users className="inline h-4 w-4 mr-1" />
              {rsvpCount} Going
            </p>
            {rsvpCount === 0 ? (
              <p className="text-sm text-muted-foreground">No RSVPs yet. Be the first!</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {rsvpCount} {rsvpCount === 1 ? "person has" : "people have"} RSVP&apos;d to this event.
              </p>
            )}
          </div>

          {/* Contact links */}
          <div className="bg-background rounded-lg border p-4">
            <button className="text-muted-foreground hover:text-foreground text-sm block mb-2">
              Contact the Host
            </button>
            <button className="text-muted-foreground hover:text-foreground text-sm block">
              Report Event
            </button>
          </div>

          {/* Tags */}
          {event.tags && event.tags.length > 0 ? (
            <div className="bg-background rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">#</span>
                {event.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {/* Chapter tags */}
          {event.chapterTags && event.chapterTags.length > 0 ? (
            <div className="bg-background rounded-lg border p-4">
              <p className="text-sm text-muted-foreground mb-2">Chapters</p>
              <div className="flex flex-wrap gap-2">
                {event.chapterTags.map((tag) => (
                  <Badge key={tag} variant="outline" className="bg-blue-50 text-blue-700">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {/* Ticket info -- sidebar display when event has a price */}
          {showTickets ? (
            <div className="bg-background rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <Ticket className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Tickets</p>
                  <p className="text-sm text-muted-foreground">{formatCurrency(ticketPrice)}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* ================================================================
            RIGHT COLUMN - Title, date, registration, tabs
            ================================================================ */}
        <div className="flex-1 flex flex-col gap-6">

          {/* Event title and date/time/location header */}
          <div className="bg-background rounded-lg border p-6">
            <h1 className="text-3xl font-bold mb-2">{event.name}</h1>

            <div className="mb-4">
              <div className="flex items-center gap-2 text-lg">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <span>{formatDayString(start)}</span>
              </div>
              <div className="text-lg ml-7">
                {formatTimeString(start)} - {formatTimeString(end)}
              </div>
            </div>

            <div className="flex items-center gap-2 mb-2">
              {locationIsVirtual ? (
                <>
                  <Video className="h-5 w-5 text-muted-foreground" />
                  <span>{locationName || "Virtual Event"}</span>
                </>
              ) : (
                <>
                  <MapPin className="h-5 w-5 text-muted-foreground" />
                  <span>{locationName}</span>
                </>
              )}
            </div>
          </div>

          {/* Registration section */}
          <div className="bg-background rounded-lg border p-6">
            <h2 className="text-xl font-semibold mb-4">Registration</h2>

            <p className="mb-4">Welcome! To join the event, please register below.</p>

            {/* RSVP and management actions (client component) */}
            <EventDetailActions eventId={event.id} showTickets={showTickets} ownerId={ownerId} />

            {/* Share and calendar toolbar (client component) */}
            <div className="mt-4 pt-4 border-t">
              <EventToolbar
                eventName={event.name}
                eventDescription={event.description}
                startDate={event.timeframe.start}
                endDate={event.timeframe.end}
                location={locationName || ""}
              />
            </div>
          </div>

          {eventGroupId ? (
            <EventTranscriptPanel
              eventId={event.id}
              initialTranscript={transcriptDocument?.content ?? ""}
              transcriptDocumentId={transcriptDocument?.id ?? null}
              transcriptionAvailable={transcriptionEnabled}
            />
          ) : null}

          {/* Tabbed content: About, Attendees, Feed, Announcements */}
          <EventDetailTabs
            eventId={event.id}
            description={event.description}
            rsvpCount={rsvpCount}
            attendees={attendees}
            ownerId={ownerId}
          />
        </div>
      </div>
    </div>
  )
}
