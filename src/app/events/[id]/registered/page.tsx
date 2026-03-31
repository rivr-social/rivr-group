import { Button } from "@/components/ui/button"
import { Check, Calendar, Share2 } from "lucide-react"
import Link from "next/link"
import { fetchAgent } from "@/app/actions/graph"
import { notFound } from "next/navigation"

export default async function EventRegisteredPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const event = await fetchAgent(id)

  if (!event) {
    notFound()
  }

  const meta = (event.metadata ?? {}) as Record<string, unknown>
  const startDate = meta.startDate ? new Date(meta.startDate as string) : new Date()
  const endDate = meta.endDate ? new Date(meta.endDate as string) : new Date()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-muted">
      <div className="max-w-md w-full bg-card rounded-lg shadow-lg overflow-hidden">
        <div className="p-8 text-center">
          <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-6">
            <Check className="h-8 w-8 text-green-600" />
          </div>

          <h1 className="text-2xl font-bold mb-2">You&apos;re registered!</h1>
          <p className="text-gray-600 mb-6">Your registration for {event.name} has been confirmed.</p>

          <div className="bg-gray-50 p-4 rounded-lg mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">{event.name}</h2>
            </div>

            <div className="flex items-center text-gray-600 mb-2">
              <Calendar className="h-4 w-4 mr-2" />
              <span>{startDate.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
            </div>

            <div className="text-gray-600">
              <span>
                {startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} -{" "}
                {endDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>

          <div className="text-sm text-gray-500 mb-6">
            A confirmation email has been sent to your registered email address.
          </div>

          <Button className="w-full" asChild>
            <Link href={`/events/${id}`}>View Event Details</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
