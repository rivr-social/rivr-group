import { redirect } from "next/navigation"

/**
 * Tabs the primary group page (`GroupTabsClient`) understands. The root page
 * forwards a requested `?tab=` through to the group page so that nav surfaces
 * (CommandBar, menus) can deep-link into a group tab via `/` without needing
 * the primary agent id on the client.
 */
const ALLOWED_HOME_TABS = new Set([
  "about",
  "feed",
  "events",
  "groups",
  "members",
  "documents",
  "jobs",
  "marketplace",
  "governance",
  "badges",
  "stake",
  "press",
  "treasury",
])

/**
 * Group instance root page.
 * Redirects to /groups/{PRIMARY_AGENT_ID} which renders the group experience,
 * forwarding a valid `?tab=` so deep-links into group tabs resolve.
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
  const tab = rawTab && ALLOWED_HOME_TABS.has(rawTab) ? rawTab : undefined

  redirect(tab ? `/groups/${primaryAgentId}?tab=${tab}` : `/groups/${primaryAgentId}`)
}
