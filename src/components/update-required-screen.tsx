"use client"

import Link from "next/link"
import { RefreshCw, Home } from "lucide-react"
import { Button } from "@/components/ui/button"

export function UpdateRequiredScreen({
  title = "Refresh to update",
  description = "This app may have been updated while you had it open. Refresh to load the latest version.",
  showHome = true,
}: {
  title?: string
  description?: string
  showHome?: boolean
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-5 px-4 text-center">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex h-16 w-16 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label="Refresh the app"
      >
        <RefreshCw className="h-7 w-7" />
      </button>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={() => window.location.reload()} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        {showHome ? (
          <Button asChild>
            <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Home
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
