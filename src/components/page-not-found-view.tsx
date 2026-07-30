import { Button } from "@/components/ui/button"
import { FileQuestion, Home } from "lucide-react"
import Link from "next/link"

/**
 * The not-found view as a plain renderable component.
 *
 * Pages whose data resolution finishes AFTER metadata streaming has begun must
 * render this directly instead of calling `notFound()` — a late `notFound()`
 * re-renders the AppRouter mid-hydration and hard-crashes the client with
 * React #310 ("Application error" screen; audit S-3, same class as the
 * 2026-07-15 sovereign-root flash). Anonymous visitors hit it first, since a
 * logged-in render resolves before the boundary swaps.
 * `app/not-found.tsx` renders the same view for genuinely unmatched routes.
 *
 * @param title Heading shown to the user; defaults to the generic page copy.
 * @param message One-line explanation under the heading.
 */
export function PageNotFoundView({
  title = "Page not found",
  message = "The page you're looking for doesn't exist or has been moved.",
}: {
  title?: string
  message?: string
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <FileQuestion className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground max-w-md">{message}</p>
      <Button asChild>
        <Link href="/">
          <Home className="mr-2 h-4 w-4" />
          Back to Home
        </Link>
      </Button>
    </div>
  )
}
