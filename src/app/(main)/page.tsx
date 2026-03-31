import { redirect } from "next/navigation"

/**
 * Group instance root page.
 * Redirects to /groups/{PRIMARY_AGENT_ID} which renders the group experience.
 */
export default function GroupHome() {
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
  redirect(`/groups/${primaryAgentId}`)
}
