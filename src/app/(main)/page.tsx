import { redirect } from "next/navigation"

import { resolveHomeRedirectPath } from "@/lib/home-tabs"

/**
 * Group instance root page — FALLBACK redirect only. The middleware issues
 * the real HTTP 307 for `/` (a streamed in-page redirect flashes the router
 * error boundary — React #310); this page covers requests the middleware
 * matcher misses and the unconfigured-instance message.
 */
export default async function GroupHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const primaryAgentId = process.env.PRIMARY_AGENT_ID
  if (!primaryAgentId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">
          Group instance not configured. Set PRIMARY_AGENT_ID environment variable.
        </p>
      </div>
    )
  }

  const params = (await searchParams) ?? {}
  const rawTab = typeof params.tab === "string" ? params.tab : undefined

  redirect(resolveHomeRedirectPath(primaryAgentId, rawTab))
}
