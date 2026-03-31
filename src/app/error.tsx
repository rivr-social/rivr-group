"use client"

import { useEffect } from "react"
import { reportError } from "@/lib/monitoring"
import { UpdateRequiredScreen } from "@/components/update-required-screen"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Unhandled error:", error)
    void reportError(error, { boundary: "app/global", digest: error.digest })
  }, [error])

  return (
    <UpdateRequiredScreen
      title="Refresh to continue"
      description="This app may have updated while you had it open. Refresh to load the latest version. If the problem continues after refreshing, try again."
      showHome={false}
    />
  )
}
