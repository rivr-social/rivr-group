"use client"

import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Client-side lazy wrapper for the settings form (same pattern as
 * design-editor-lazy / chat route-client-lazy). The form is a ~3k-line client
 * component with no SSR value (interactive, authed-only), so deferring its
 * chunk lets the /settings shell paint immediately instead of shipping the
 * whole form in the route's first load.
 */
export const SettingsFormLazy = dynamic(
  () => import("./settings-form").then((mod) => mod.SettingsForm),
  {
    ssr: false,
    loading: () => (
      <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    ),
  },
)
