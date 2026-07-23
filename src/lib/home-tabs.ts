/**
 * @module home-tabs
 *
 * The root-page → primary-group redirect contract, shared by the edge
 * middleware (which issues a real HTTP 307 so the browser never renders an
 * intermediate page) and the `(main)/page.tsx` fallback redirect.
 *
 * Pure and dependency-free: imported by middleware (edge runtime) and server
 * components alike.
 */

/**
 * Tabs the primary group page (`GroupTabsClient`) understands. The root path
 * forwards a requested `?tab=` through to the group page so that nav surfaces
 * (CommandBar, menus) can deep-link into a group tab via `/` without needing
 * the primary agent id on the client.
 */
export const ALLOWED_HOME_TABS: ReadonlySet<string> = new Set([
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
  "stock",
  "treasury",
])

/**
 * Resolves the local path the root URL redirects to for this instance's
 * primary group, forwarding `rawTab` only when it names a known group tab.
 *
 * @param primaryAgentId - The instance's `PRIMARY_AGENT_ID`.
 * @param rawTab - The raw `?tab=` query value, if any.
 * @returns The `/groups/{id}` path (with a validated `?tab=` forwarded).
 */
export function resolveHomeRedirectPath(
  primaryAgentId: string,
  rawTab?: string | null,
): string {
  const tab = rawTab && ALLOWED_HOME_TABS.has(rawTab) ? rawTab : undefined
  return tab
    ? `/groups/${primaryAgentId}?tab=${tab}`
    : `/groups/${primaryAgentId}`
}
