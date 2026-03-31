/**
 * @fileoverview EventToolbar - Share and calendar actions for the event detail page.
 *
 * Client component that provides interactive toolbar buttons for sharing an event
 * link and adding the event to Google Calendar. Rendered inside the Server Component
 * event detail page with pre-fetched props passed from the server.
 */
"use client"

import { Button } from "@/components/ui/button"
import { Share2, CalendarPlus } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

/** Props required by the EventToolbar to generate share and calendar links. */
interface EventToolbarProps {
  /** Display name of the event, used as the calendar event title. */
  eventName: string
  /** Event description text, included in the calendar event details. */
  eventDescription: string
  /** ISO 8601 start date string for the event. */
  startDate: string
  /** ISO 8601 end date string for the event. */
  endDate: string
  /** Human-readable location string for the calendar event. */
  location: string
}

/**
 * Renders share and add-to-calendar action buttons for the event detail page.
 *
 * Share copies the current page URL to the clipboard. Add to Calendar opens a
 * new tab with a pre-filled Google Calendar event creation form.
 *
 * @param props - Event metadata used to build the calendar link and share target.
 * @returns Interactive toolbar with Share and Add to Calendar buttons.
 */
export function EventToolbar({ eventName, eventDescription, startDate, endDate, location }: EventToolbarProps) {
  const { toast } = useToast()

  /**
   * Copies the current page URL to the clipboard and shows a confirmation toast.
   */
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast({ title: "Link copied to clipboard" })
    } catch {
      toast({ title: "Could not copy link", variant: "destructive" })
    }
  }

  /**
   * Opens Google Calendar in a new tab with pre-filled event details.
   *
   * Google Calendar URL format requires dates in `YYYYMMDDTHHmmssZ` format
   * with punctuation removed from the ISO string.
   */
  const handleAddToCalendar = () => {
    const formatDateForGCal = (isoDate: string): string => {
      return new Date(isoDate).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
    }

    const start = formatDateForGCal(startDate)
    const end = formatDateForGCal(endDate)
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(eventName)}&dates=${start}/${end}&details=${encodeURIComponent(eventDescription)}&location=${encodeURIComponent(location)}`
    window.open(url, "_blank")
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => void handleShare()}>
        <Share2 className="h-4 w-4 mr-2" />
        Share
      </Button>
      <Button variant="outline" size="sm" onClick={handleAddToCalendar}>
        <CalendarPlus className="h-4 w-4 mr-2" />
        Add to Calendar
      </Button>
    </div>
  )
}
