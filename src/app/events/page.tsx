import { redirect } from "next/navigation"

/**
 * /events index redirect.
 *
 * No dedicated events listing page exists — events are displayed on the home feed.
 * This page prevents 404 loops when navigating to /events directly.
 */
export default function EventsIndexPage() {
  redirect("/")
}
