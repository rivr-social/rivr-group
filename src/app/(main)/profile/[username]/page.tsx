import { notFound, redirect } from "next/navigation"
import type { Metadata } from "next"
import { fetchAgentByUsername, fetchPublicAgentById } from "@/app/actions/graph"
import { buildPersonMetadata } from "@/lib/object-metadata"
import { getGlobalBaseUrl } from "@/lib/federation/global-url"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function resolveProfileAgent(usernameOrId: string) {
  const trimmed = usernameOrId.trim()
  if (!trimmed) return null

  if (UUID_RE.test(trimmed)) {
    const agent = await fetchPublicAgentById(trimmed)
    return agent?.type === "person" ? agent : null
  }

  return fetchAgentByUsername(trimmed)
}

async function getProfilePageData(username: string) {
  const agent = await resolveProfileAgent(username)
  if (!agent) return null
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>

  return {
    agent,
    profile: {
      id: agent.id,
      name: agent.name,
      description: agent.description || (typeof metadata.bio === "string" ? metadata.bio : null),
      image: agent.image,
      username: typeof metadata.username === "string" ? metadata.username : username,
      location: typeof metadata.location === "string" ? metadata.location : null,
      chapterTags: Array.isArray(metadata.chapterTags) ? metadata.chapterTags.filter((tag): tag is string => typeof tag === "string") : [],
      skills: Array.isArray(metadata.skills) ? metadata.skills.filter((skill): skill is string => typeof skill === "string") : [],
      metadata,
    },
  }
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params
  const data = await getProfilePageData(username)

  if (!data) {
    return {
      title: "Profile Not Found | RIVR",
    }
  }

  return buildPersonMetadata(data.agent, data.profile.username || username)
}

/**
 * NO MIRRORS: this is a group sovereign, which is NEVER a person's canonical
 * home. Instead of rendering a local person-profile mirror, redirect to the
 * person's real home: their explicit `homeBaseUrl`/`canonicalUrl` if the row
 * carries one, otherwise the global hub (which homes people). This closes the
 * gap left when the self `/profile` route got `redirectFederatedViewerHome`
 * but the public `/profile/[username]` route did not, and matches the
 * sovereign-redirect coverage groups/projects/group-settings already have.
 */
export default async function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const data = await getProfilePageData(username)

  if (!data) {
    notFound()
  }

  const meta = data.profile.metadata
  const explicitHome =
    (typeof meta.homeBaseUrl === "string" && meta.homeBaseUrl.trim()) ||
    (typeof meta.canonicalUrl === "string" && meta.canonicalUrl.trim()) ||
    null
  const homeBase = (explicitHome ?? getGlobalBaseUrl()).replace(/\/+$/, "")
  const identifier = data.profile.username?.trim() || data.agent.id
  redirect(`${homeBase}/profile/${encodeURIComponent(identifier)}`)
}
