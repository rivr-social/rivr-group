"use client"

import { useEffect } from "react"
import { reportError } from "@/lib/monitoring"
import { UpdateRequiredScreen } from "@/components/update-required-screen"

export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Page error:", error)
    void reportError(error, { boundary: "app/main", digest: error.digest })
  }, [error])

  return (
    <UpdateRequiredScreen
      title="Refresh to update"
      description="This page may be using an older version of the app. Refresh to reload the latest version, or go back home."
    />
  )
}
