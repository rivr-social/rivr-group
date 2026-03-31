/**
 * @fileoverview EventDetailActions - RSVP and management actions for an event detail page.
 *
 * Shown on the event detail page. Provides RSVP toggling via the `setEventRsvp`
 * server action, edit/delete capabilities for event owners via `deleteResource`,
 * and share functionality.
 */
"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setEventRsvp } from "@/app/actions/interactions";
import { deleteResource } from "@/app/actions/create-resources";
import { useToast } from "@/components/ui/use-toast";
import { useUser } from "@/contexts/user-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface EventDetailActionsProps {
  eventId: string;
  showTickets: boolean;
  ownerId?: string;
}

/**
 * Action row for the event detail page.
 *
 * Used on the event details feature to let users RSVP and optionally navigate to ticket purchase.
 *
 * Key props:
 * - `eventId`: event identifier used by RSVP server action and ticket route
 * - `showTickets`: controls whether the ticket CTA is rendered
 */
/**
 * Renders RSVP actions and optional ticket CTA for a specific event.
 *
 * @param props - Event detail action configuration.
 * @param props.eventId - Event id passed to RSVP server action and ticket link.
 * @param props.showTickets - Whether to render the "Get Tickets" button.
 * @param props.ownerId - Optional owner id; when provided and matches current user, edit/delete actions render.
 */
export function EventDetailActions({ eventId, showTickets, ownerId }: EventDetailActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { currentUser } = useUser();
  // Local pending state tracks in-flight RSVP submissions and disables duplicate clicks.
  const [pending, setPending] = useState<"going" | "interested" | "none" | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const isOwner = Boolean(ownerId && currentUser?.id === ownerId);

  const handleRsvp = async (status: "going" | "interested" | "none") => {
    // Mark current action pending before calling the server action.
    setPending(status);
    try {
      // Side effect: server action call persists RSVP status for this event.
      const result = await setEventRsvp(eventId, status);
      if (!result.success) {
        // Side effect: destructive toast feedback when server update fails.
        toast({ title: "Could not update RSVP", description: result.message, variant: "destructive" });
        return;
      }
      // Side effect: success toast confirms RSVP mutation.
      toast({ title: "RSVP updated", description: result.message });
    } finally {
      // Clear pending state regardless of success/failure to re-enable action buttons.
      setPending(null);
    }
  };

  /**
   * Deletes the event resource and returns the owner to home on success.
   */
  const handleDeleteEvent = async () => {
    setIsDeleting(true);
    try {
      const result = await deleteResource(eventId);
      if (!result.success) {
        toast({ title: "Could not delete event", description: result.message, variant: "destructive" });
        return;
      }

      setIsDeleteOpen(false);
      toast({ title: "Event deleted" });
      router.push("/");
      router.refresh();
    } catch {
      toast({ title: "Could not delete event", description: "An unexpected error occurred.", variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void handleRsvp("going")} disabled={pending !== null}>
        {pending === "going" ? "Updating..." : "RSVP Going"}
      </Button>
      <Button variant="outline" onClick={() => void handleRsvp("interested")} disabled={pending !== null}>
        {pending === "interested" ? "Updating..." : "Interested"}
      </Button>
      {isOwner ? (
        <Link href={`/events/${eventId}/edit`}>
          <Button variant="outline">Edit</Button>
        </Link>
      ) : null}
      {isOwner ? (
        <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this event?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. The event will be removed from active surfaces.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleDeleteEvent()} disabled={isDeleting}>
                {isDeleting ? "Deleting..." : "Delete event"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {/* Conditional rendering: ticket CTA appears only when ticketing is enabled for this event. */}
      {showTickets ? (
        <Link href={`/events/${eventId}/tickets`}>
          <Button variant="secondary">Get Tickets</Button>
        </Link>
      ) : null}
    </div>
  );
}
